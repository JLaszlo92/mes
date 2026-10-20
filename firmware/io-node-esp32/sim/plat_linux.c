/* Linux simulator: plat.h with POSIX threads. A "reboot" exits with code 75; sim/run.sh starts the process again. */
#define _GNU_SOURCE
#include <openssl/pem.h>
#include <openssl/x509.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "esp_log.h"
#include "plat.h"

struct plat_queue {
    pthread_mutex_t mu;
    pthread_cond_t cv;
    size_t len, size, head, count;
    unsigned char *buf;
};

plat_queue_t *plat_queue_new(size_t length, size_t item_size)
{
    plat_queue_t *q = calloc(1, sizeof *q);
    q->len = length;
    q->size = item_size;
    q->buf = calloc(length, item_size);
    pthread_mutex_init(&q->mu, NULL);
    pthread_cond_init(&q->cv, NULL);
    return q;
}

static void deadline(struct timespec *ts, int ms)
{
    clock_gettime(CLOCK_REALTIME, ts);
    ts->tv_sec += ms / 1000;
    ts->tv_nsec += (long)(ms % 1000) * 1000000L;
    if (ts->tv_nsec >= 1000000000L) {
        ts->tv_sec++;
        ts->tv_nsec -= 1000000000L;
    }
}

bool plat_queue_send(plat_queue_t *q, const void *item, int timeout_ms)
{
    struct timespec ts;
    deadline(&ts, timeout_ms);
    pthread_mutex_lock(&q->mu);
    while (q->count == q->len) {
        if (timeout_ms == 0 || pthread_cond_timedwait(&q->cv, &q->mu, &ts) != 0) {
            pthread_mutex_unlock(&q->mu);
            return false;
        }
    }
    memcpy(q->buf + ((q->head + q->count) % q->len) * q->size, item, q->size);
    q->count++;
    pthread_cond_broadcast(&q->cv);
    pthread_mutex_unlock(&q->mu);
    return true;
}

bool plat_queue_recv(plat_queue_t *q, void *item, int timeout_ms)
{
    struct timespec ts;
    deadline(&ts, timeout_ms);
    pthread_mutex_lock(&q->mu);
    while (q->count == 0) {
        if (timeout_ms == 0 || pthread_cond_timedwait(&q->cv, &q->mu, &ts) != 0) {
            pthread_mutex_unlock(&q->mu);
            return false;
        }
    }
    memcpy(item, q->buf + q->head * q->size, q->size);
    q->head = (q->head + 1) % q->len;
    q->count--;
    pthread_cond_broadcast(&q->cv);
    pthread_mutex_unlock(&q->mu);
    return true;
}

static pthread_mutex_t s_nmu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t s_ncv = PTHREAD_COND_INITIALIZER;
static int s_notified;

void plat_agent_bind(void) {}
void plat_agent_notify(void)
{
    pthread_mutex_lock(&s_nmu);
    s_notified = 1;
    pthread_cond_signal(&s_ncv);
    pthread_mutex_unlock(&s_nmu);
}
void plat_agent_wait(int ms)
{
    struct timespec ts;
    deadline(&ts, ms);
    pthread_mutex_lock(&s_nmu);
    if (!s_notified) pthread_cond_timedwait(&s_ncv, &s_nmu, &ts);
    s_notified = 0;
    pthread_mutex_unlock(&s_nmu);
}

typedef struct {
    void (*fn)(void *);
    void *arg;
} start_t;
static void *trampoline(void *p)
{
    start_t s = *(start_t *)p;
    free(p);
    s.fn(s.arg);
    return NULL;
}
void plat_thread(void (*fn)(void *), const char *name, size_t stack, void *arg)
{
    (void)name;
    (void)stack;
    start_t *s = malloc(sizeof *s);
    s->fn = fn;
    s->arg = arg;
    pthread_t t;
    pthread_create(&t, NULL, trampoline, s);
    pthread_detach(t);
}
void plat_sleep_ms(int ms) { usleep((useconds_t)ms * 1000); }
size_t plat_stack_unused(const char *task)
{
    (void)task;
    return 0;
}

static int64_t s_mono0 = -1;
int64_t plat_mono_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    int64_t v = (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
    if (s_mono0 < 0) s_mono0 = v;
    return v - s_mono0; /* like esp_timer: 0 at boot */
}

/* The simulated device clock: host time plus an offset (SIM_CLOCK_OFFSET_MS = a wrong clock at boot). */
static int64_t s_wall_offset;
static int s_wall_init;
int64_t plat_wall_ms(void)
{
    if (!s_wall_init) {
        s_wall_init = 1;
        const char *o = getenv("SIM_CLOCK_OFFSET_MS");
        if (o) s_wall_offset = atoll(o);
    }
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000 + s_wall_offset;
}
void plat_set_wall_ms(int64_t ms)
{
    int64_t host = plat_wall_ms() - s_wall_offset;
    s_wall_offset = ms - host;
}

void plat_random(void *buf, size_t len)
{
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f || fread(buf, 1, len, f) != len) abort();
    fclose(f);
}

void *plat_big_alloc(size_t n) { return malloc(n); }
size_t plat_big_free(void) { return 8u * 1024 * 1024; } /* like the board's PSRAM */
size_t plat_internal_free(void) { return 300u * 1024; }

static volatile int64_t s_fed = -1;
static void *wdt_thread(void *arg)
{
    (void)arg;
    for (;;) {
        sleep(1);
        if (s_fed >= 0 && plat_mono_ms() - s_fed > 15000) {
            fprintf(stderr, "E (%lld) wdt: task watchdog got triggered - rebooting\n", (long long)plat_mono_ms());
            _exit(75);
        }
    }
    return NULL;
}
void plat_wdt_add(void)
{
    s_fed = plat_mono_ms();
    pthread_t t;
    pthread_create(&t, NULL, wdt_thread, NULL);
    pthread_detach(t);
}
void plat_wdt_feed(void) { s_fed = plat_mono_ms(); }

void plat_restart(void)
{
    fprintf(stderr, "I (%lld) sim: reboot (exit 75)\n", (long long)plat_mono_ms());
    fflush(NULL);
    _exit(75);
}

const char *plat_version(void) { return "io-node-v1-sim"; }

int64_t plat_cert_expiry_ms(const char *pem)
{
    BIO *b = BIO_new_mem_buf(pem, -1);
    X509 *x = b ? PEM_read_bio_X509(b, NULL, NULL, NULL) : NULL;
    int64_t ms = 0;
    struct tm tm;
    if (x && ASN1_TIME_to_tm(X509_get0_notAfter(x), &tm) == 1) ms = (int64_t)timegm(&tm) * 1000;
    X509_free(x);
    BIO_free(b);
    return ms;
}

void plat_sntp_start(const char *server, void (*on_sync)(void))
{
    (void)on_sync;
    ESP_LOGW("plat", "NTP (%s) is not simulated", server);
}
