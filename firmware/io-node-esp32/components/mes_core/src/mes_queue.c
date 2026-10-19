#include "mes_queue.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define NO_SEG UINT32_MAX
#define ENTRY_OVERHEAD 96 /* bookkeeping counted against the limit next to the line itself */

typedef struct {
    char *line;
    size_t len;
    uint32_t seg;
    bool acked;
    bool sent;
    int64_t last_sent;
    char id[64];
} entry_t;

typedef struct {
    uint32_t seq;
    uint32_t count;
    uint32_t acked;
} seg_t;

struct mes_queue {
    char dir[96];
    char machine_id[96];
    size_t cap;
    size_t bytes;   /* unacknowledged lines + overhead */
    size_t pending; /* unacknowledged events */
    entry_t *e;
    size_t head, n, alloc; /* live entries are e[head .. n) */
    seg_t *segs;
    size_t nsegs, segs_alloc;
    FILE *wf;
    uint32_t wseq;
    size_t wbytes;
    bool dirty;
    int64_t last_sync;
    uint32_t next_seq;
    size_t skipped;
    mes_dropped_t dropped;
};

static void *(*s_alloc)(size_t) = malloc;
static void (*s_free)(void *) = free;

void mes_queue_set_allocator(void *(*alloc)(size_t), void (*release)(void *))
{
    s_alloc = alloc ? alloc : malloc;
    s_free = release ? release : free;
}

static void seg_path(const mes_queue_t *q, uint32_t seq, char *out, size_t cap)
{
    snprintf(out, cap, "%s/%08x.log", q->dir, (unsigned)seq);
}

static seg_t *find_seg(mes_queue_t *q, uint32_t seq)
{
    for (size_t i = 0; i < q->nsegs; i++)
        if (q->segs[i].seq == seq) return &q->segs[i];
    return NULL;
}

static seg_t *add_seg(mes_queue_t *q, uint32_t seq)
{
    if (q->nsegs == q->segs_alloc) {
        size_t na = q->segs_alloc ? q->segs_alloc * 2 : 16;
        seg_t *ns = realloc(q->segs, na * sizeof *ns);
        if (!ns) return NULL;
        q->segs = ns;
        q->segs_alloc = na;
    }
    seg_t *s = &q->segs[q->nsegs++];
    s->seq = seq;
    s->count = s->acked = 0;
    return s;
}

static bool reserve_entry(mes_queue_t *q)
{
    if (q->head > 0 && q->head * 2 >= q->n) { /* compact: most of the array is acknowledged history */
        memmove(q->e, q->e + q->head, (q->n - q->head) * sizeof *q->e);
        q->n -= q->head;
        q->head = 0;
    }
    if (q->n < q->alloc) return true;
    size_t na = q->alloc ? q->alloc * 2 : 64;
    entry_t *ne = s_alloc(na * sizeof *ne);
    if (!ne) return false;
    if (q->e) {
        memcpy(ne, q->e, q->n * sizeof *ne);
        s_free(q->e);
    }
    q->e = ne;
    q->alloc = na;
    return true;
}

static void advance_head(mes_queue_t *q)
{
    while (q->head < q->n && q->e[q->head].acked) q->head++;
    if (q->head == q->n) q->head = q->n = 0;
}

static void settle(mes_queue_t *q, entry_t *x)
{
    if (x->acked) return;
    x->acked = true;
    q->bytes -= x->len + ENTRY_OVERHEAD;
    q->pending--;
    s_free(x->line);
    x->line = NULL;
    if (x->seg != NO_SEG) {
        seg_t *s = find_seg(q, x->seg);
        if (s) s->acked++;
    }
}

/* The sourceEventId of a stored line; false if the line is not a complete event. */
static bool id_of(const char *line, char *id, size_t cap)
{
    size_t len = strlen(line);
    if (len < 2 || line[0] != '{' || line[len - 1] != '}') return false;
    const char *k = strstr(line, "\"sourceEventId\":\"");
    if (!k) return false;
    k += strlen("\"sourceEventId\":\"");
    const char *end = strchr(k, '"');
    if (!end || end == k || (size_t)(end - k) >= cap) return false;
    memcpy(id, k, (size_t)(end - k));
    id[end - k] = 0;
    return true;
}

static bool machine_of(const char *line, char *out, size_t cap)
{
    const char *k = strstr(line, "\"machineId\":\"");
    if (!k) return false;
    k += strlen("\"machineId\":\"");
    size_t n = 0;
    for (const char *p = k; *p && *p != '"'; p++) {
        if (*p == '\\') return false; /* escaped ids are never produced for real machine ids; refuse rather than guess */
        if (n + 1 >= cap) return false;
        out[n++] = *p;
    }
    out[n] = 0;
    return n > 0;
}

static bool add_entry(mes_queue_t *q, const char *line, size_t len, const char *id, uint32_t seg)
{
    if (!reserve_entry(q)) return false;
    char *copy = s_alloc(len + 1);
    if (!copy) return false;
    memcpy(copy, line, len);
    copy[len] = 0;
    entry_t *x = &q->e[q->n++];
    memset(x, 0, sizeof *x);
    x->line = copy;
    x->len = len;
    x->seg = seg;
    strncpy(x->id, id, sizeof x->id - 1);
    q->bytes += len + ENTRY_OVERHEAD;
    q->pending++;
    if (seg != NO_SEG) {
        seg_t *s = find_seg(q, seg);
        if (s) s->count++;
    }
    return true;
}

static int cmp_u32(const void *a, const void *b)
{
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return x < y ? -1 : x > y;
}

static void load(mes_queue_t *q)
{
    DIR *d = opendir(q->dir);
    if (!d) return;
    uint32_t *seqs = NULL;
    size_t ns = 0, na = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        unsigned v;
        char tail[8];
        if (sscanf(de->d_name, "%8x.%3s", &v, tail) == 2 && strcmp(tail, "log") == 0 && strlen(de->d_name) == 12) {
            if (ns == na) {
                na = na ? na * 2 : 16;
                uint32_t *n2 = realloc(seqs, na * sizeof *n2);
                if (!n2) break;
                seqs = n2;
            }
            seqs[ns++] = v;
        }
    }
    closedir(d);
    if (ns > 1) qsort(seqs, ns, sizeof *seqs, cmp_u32);
    char *buf = malloc(MES_QUEUE_MAX_LINE + 2);
    for (size_t i = 0; buf && i < ns; i++) {
        char path[160];
        seg_path(q, seqs[i], path, sizeof path);
        if (seqs[i] >= q->next_seq) q->next_seq = seqs[i] + 1;
        FILE *f = fopen(path, "r");
        if (!f) continue;
        add_seg(q, seqs[i]);
        while (fgets(buf, MES_QUEUE_MAX_LINE + 2, f)) {
            size_t len = strlen(buf);
            bool whole = len > 0 && buf[len - 1] == '\n';
            if (!whole) { /* longer than any event we write, or cut by a power loss */
                q->skipped++;
                int c;
                while ((c = fgetc(f)) != EOF && c != '\n') {}
                continue;
            }
            buf[--len] = 0;
            if (len == 0) continue;
            char id[64];
            if (!id_of(buf, id, sizeof id)) {
                q->skipped++;
                continue;
            }
            if (q->machine_id[0] == 0 && !machine_of(buf, q->machine_id, sizeof q->machine_id)) {
                q->skipped++;
                continue;
            }
            add_entry(q, buf, len, id, seqs[i]);
        }
        fclose(f);
        seg_t *s = find_seg(q, seqs[i]);
        if (s && s->count == 0) { /* nothing usable in it */
            unlink(path);
            *s = q->segs[--q->nsegs];
        }
    }
    free(buf);
    free(seqs);
}

mes_queue_t *mes_queue_open(const char *dir, const char *machine_id, size_t cap)
{
    mes_queue_t *q = calloc(1, sizeof *q);
    if (!q) return NULL;
    snprintf(q->dir, sizeof q->dir, "%s", dir);
    if (machine_id) snprintf(q->machine_id, sizeof q->machine_id, "%s", machine_id);
    q->cap = cap;
    q->wseq = NO_SEG;
    mkdir(dir, 0775);
    load(q);
    if (q->machine_id[0] == 0) { /* an orphan buffer without a usable event */
        mes_queue_destroy(q);
        return NULL;
    }
    return q;
}

static void close_writer(mes_queue_t *q)
{
    if (!q->wf) return;
    fflush(q->wf);
    fsync(fileno(q->wf));
    fclose(q->wf);
    q->wf = NULL;
    q->dirty = false;
    q->wseq = NO_SEG;
    q->wbytes = 0;
}

static bool open_writer(mes_queue_t *q)
{
    char path[160];
    uint32_t seq = q->next_seq++;
    seg_path(q, seq, path, sizeof path);
    q->wf = fopen(path, "a");
    if (!q->wf) return false;
    if (!add_seg(q, seq)) {
        fclose(q->wf);
        q->wf = NULL;
        unlink(path);
        return false;
    }
    q->wseq = seq;
    q->wbytes = 0;
    return true;
}

static void drop_oldest(mes_queue_t *q)
{
    for (size_t i = q->head; i < q->n; i++) {
        entry_t *x = &q->e[i];
        if (x->acked) continue;
        if (strstr(x->line, "\"type\":\"production_count\"")) {
            if (strstr(x->line, "\"result\":\"scrap\"")) q->dropped.scrap++;
            else q->dropped.good++;
        } else {
            q->dropped.other++;
        }
        settle(q, x);
        advance_head(q);
        return;
    }
}

bool mes_queue_push(mes_queue_t *q, const char *json, const char *id)
{
    size_t len = strlen(json);
    if (len == 0 || len > MES_QUEUE_MAX_LINE) return false;
    while (q->pending > 0 && q->bytes + len + ENTRY_OVERHEAD > q->cap) drop_oldest(q);

    uint32_t seg = NO_SEG;
    if (q->wf && q->wbytes >= MES_QUEUE_SEGMENT_BYTES) close_writer(q);
    if (q->wf || open_writer(q)) {
        if (fwrite(json, 1, len, q->wf) == len && fputc('\n', q->wf) != EOF) {
            seg = q->wseq;
            q->wbytes += len + 1;
            q->dirty = true;
        } else {
            close_writer(q); /* flash full or failing: keep the event in RAM only, try a new segment next time */
        }
    }
    return add_entry(q, json, len, id, seg);
}

static entry_t *last_entry(mes_queue_t *q)
{
    return q->n > q->head ? &q->e[q->n - 1] : NULL;
}

void mes_queue_send_last(mes_queue_t *q, int64_t now, mes_send_fn send, void *ctx)
{
    entry_t *x = last_entry(q);
    if (!x || x->acked || x->sent) return;
    if (send(ctx, x->line, x->len)) {
        x->sent = true;
        x->last_sent = now;
    }
}

int mes_queue_sweep(mes_queue_t *q, int64_t now, int max, mes_send_fn send, void *ctx)
{
    int sent = 0;
    for (size_t i = q->head; i < q->n && sent < max; i++) {
        entry_t *x = &q->e[i];
        if (x->acked) continue;
        if (x->sent && now - x->last_sent < MES_RETRY_MIN_AGE_MS) continue;
        if (!send(ctx, x->line, x->len)) break;
        x->sent = true;
        x->last_sent = now;
        sent++;
    }
    return sent;
}

void mes_queue_reset_sent(mes_queue_t *q)
{
    for (size_t i = q->head; i < q->n; i++) q->e[i].sent = false;
}

bool mes_queue_ack(mes_queue_t *q, const char *id)
{
    for (size_t i = q->head; i < q->n; i++) { /* acks arrive roughly in order: usually found at the head */
        entry_t *x = &q->e[i];
        if (!x->acked && strcmp(x->id, id) == 0) {
            settle(q, x);
            advance_head(q);
            return true;
        }
    }
    return false;
}

void mes_queue_tick(mes_queue_t *q, int64_t now, bool force)
{
    if (q->wf && q->dirty && (force || now - q->last_sync >= MES_QUEUE_SYNC_MS)) {
        fflush(q->wf);
        fsync(fileno(q->wf));
        q->dirty = false;
        q->last_sync = now;
    }
    for (size_t i = 0; i < q->nsegs;) {
        seg_t *s = &q->segs[i];
        bool done = s->acked >= s->count;
        bool is_writer = q->wf && s->seq == q->wseq;
        /* A drained writer is closed (and deleted below) once it is big or idle, so that a restart does not send its
         * already acknowledged events again; the next event opens a new segment. */
        if (done && is_writer && (q->wbytes >= MES_QUEUE_SEGMENT_BYTES / 4 || (!q->dirty && now - q->last_sync >= MES_QUEUE_IDLE_CLOSE_MS))) {
            close_writer(q);
            is_writer = false;
        }
        if (done && !is_writer) { /* every event of it is acknowledged (or dropped): no entry refers to it any more */
            char path[160];
            seg_path(q, s->seq, path, sizeof path);
            unlink(path);
            q->segs[i] = q->segs[--q->nsegs];
            continue;
        }
        i++;
    }
}

static void free_entries(mes_queue_t *q)
{
    for (size_t i = q->head; i < q->n; i++) s_free(q->e[i].line);
    s_free(q->e);
    free(q->segs);
}

void mes_queue_close(mes_queue_t *q)
{
    if (!q) return;
    close_writer(q);
    free_entries(q);
    free(q);
}

void mes_queue_destroy(mes_queue_t *q)
{
    if (!q) return;
    close_writer(q);
    DIR *d = opendir(q->dir);
    if (d) {
        struct dirent *de;
        char path[384];
        while ((de = readdir(d)) != NULL) {
            if (de->d_name[0] == '.') continue;
            snprintf(path, sizeof path, "%s/%s", q->dir, de->d_name);
            unlink(path);
        }
        closedir(d);
    }
    rmdir(q->dir);
    free_entries(q);
    free(q);
}

const char *mes_queue_machine_id(const mes_queue_t *q) { return q->machine_id; }
const char *mes_queue_dir(const mes_queue_t *q) { return q->dir; }
void mes_queue_set_cap(mes_queue_t *q, size_t cap) { q->cap = cap; }
size_t mes_queue_pending(const mes_queue_t *q) { return q->pending; }
size_t mes_queue_bytes(const mes_queue_t *q) { return q->bytes; }
size_t mes_queue_cap(const mes_queue_t *q) { return q->cap; }
size_t mes_queue_load_skipped(const mes_queue_t *q) { return q->skipped; }

mes_dropped_t mes_queue_take_dropped(mes_queue_t *q)
{
    mes_dropped_t d = q->dropped;
    memset(&q->dropped, 0, sizeof q->dropped);
    return d;
}
