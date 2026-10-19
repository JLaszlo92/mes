#include "mes_util.h"

#include <stdio.h>
#include <string.h>

/* Days since 1970-01-01 -> civil date (Howard Hinnant's algorithm); no time zone, no libc tm. */
static void civil_from_days(int64_t z, int *y, unsigned *m, unsigned *d)
{
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = (unsigned)(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t yy = (int64_t)yoe + era * 400;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    *d = doy - (153 * mp + 2) / 5 + 1;
    *m = mp < 10 ? mp + 3 : mp - 9;
    *y = (int)(yy + (*m <= 2));
}

/* Civil date -> days since 1970-01-01 (the inverse of civil_from_days). */
static int64_t days_from_civil(int64_t y, unsigned m, unsigned d)
{
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (int64_t)doe - 719468;
}

int64_t mes_epoch_ms_utc(int year, int month, int day, int hour, int minute, int second)
{
    int64_t days = days_from_civil(year, (unsigned)month, (unsigned)day);
    return ((days * 86400) + hour * 3600LL + minute * 60LL + second) * 1000;
}

void mes_iso8601(int64_t epoch_ms, char out[32])
{
    int64_t secs = epoch_ms / 1000;
    int ms = (int)(epoch_ms % 1000);
    if (ms < 0) {
        ms += 1000;
        secs -= 1;
    }
    int64_t days = secs / 86400;
    int64_t rem = secs % 86400;
    if (rem < 0) {
        rem += 86400;
        days -= 1;
    }
    int y;
    unsigned m, d;
    civil_from_days(days, &y, &m, &d);
    char tmp[80];
    snprintf(tmp, sizeof tmp, "%04d-%02u-%02uT%02d:%02d:%02d.%03dZ", y, m, d, (int)(rem / 3600), (int)(rem / 60 % 60), (int)(rem % 60), ms);
    memcpy(out, tmp, 31);
    out[31] = 0;
}

void mes_uuid4(char out[37], mes_random_fn rnd)
{
    uint8_t b[16];
    rnd(b, sizeof b);
    b[6] = (uint8_t)((b[6] & 0x0f) | 0x40);
    b[8] = (uint8_t)((b[8] & 0x3f) | 0x80);
    snprintf(out, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8],
             b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
}

int mes_json_escape(const char *in, char *out, size_t cap)
{
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)in; *p; p++) {
        char tmp[8];
        const char *rep = NULL;
        size_t rl = 1;
        switch (*p) {
        case '"': rep = "\\\""; rl = 2; break;
        case '\\': rep = "\\\\"; rl = 2; break;
        case '\n': rep = "\\n"; rl = 2; break;
        case '\r': rep = "\\r"; rl = 2; break;
        case '\t': rep = "\\t"; rl = 2; break;
        default:
            if (*p < 0x20) {
                snprintf(tmp, sizeof tmp, "\\u%04x", *p);
                rep = tmp;
                rl = 6;
            }
        }
        if (n + rl + 1 > cap) return -1;
        if (rep) memcpy(out + n, rep, rl);
        else out[n] = (char)*p;
        n += rl;
    }
    if (n + 1 > cap) return -1;
    out[n] = 0;
    return (int)n;
}

uint32_t mes_fnv1a(const char *s)
{
    uint32_t h = 2166136261u;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        h ^= *p;
        h *= 16777619u;
    }
    return h;
}

/* ---- SHA-256 (FIPS 180-4), small and portable: only hashes the node token for the claim cache. ---- */

static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
    0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
    0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_block(uint32_t h[8], const uint8_t blk[64])
{
    uint32_t w[64];
    for (int i = 0; i < 16; i++) w[i] = (uint32_t)blk[4 * i] << 24 | (uint32_t)blk[4 * i + 1] << 16 | (uint32_t)blk[4 * i + 2] << 8 | blk[4 * i + 3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = hh + (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
        uint32_t t2 = (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
        hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

void mes_sha256_hex(const void *data, size_t len, char out[65])
{
    uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    const uint8_t *p = (const uint8_t *)data;
    size_t left = len;
    while (left >= 64) {
        sha256_block(h, p);
        p += 64;
        left -= 64;
    }
    uint8_t tail[128] = {0};
    memcpy(tail, p, left);
    tail[left] = 0x80;
    size_t tl = left < 56 ? 64 : 128;
    uint64_t bits = (uint64_t)len * 8;
    for (int i = 0; i < 8; i++) tail[tl - 1 - i] = (uint8_t)(bits >> (8 * i));
    sha256_block(h, tail);
    if (tl == 128) sha256_block(h, tail + 64);
    for (int i = 0; i < 8; i++) snprintf(out + 8 * i, 9, "%08x", (unsigned)h[i]);
}
