#include "mes_signal.h"

#include <string.h>

void mes_debounce_init(mes_debounce_t *d, uint32_t hold_ms, bool level)
{
    memset(d, 0, sizeof *d);
    d->hold_ms = hold_ms;
    d->stable = level;
}

bool mes_debounce_poll(mes_debounce_t *d, int64_t now, int64_t *changed_at)
{
    if (!d->has_candidate || now - d->candidate_since < (int64_t)d->hold_ms) return false;
    d->stable = d->candidate;
    d->has_candidate = false;
    *changed_at = d->candidate_since;
    return true;
}

bool mes_debounce_feed(mes_debounce_t *d, bool level, int64_t t, int64_t *changed_at)
{
    bool committed = mes_debounce_poll(d, t, changed_at);
    if (level == d->stable) {
        d->has_candidate = false; /* a bounce back to the accepted level: the candidate was too short */
    } else if (!d->has_candidate || d->candidate != level) {
        d->has_candidate = true;
        d->candidate = level;
        d->candidate_since = t;
    }
    return committed;
}

static void emit(mes_chan_logic_t *c, mes_reading_kind_t kind, int64_t t)
{
    mes_reading_t r = {.kind = kind, .t = t};
    c->emit(c->ctx, &r);
}

static void on_status(mes_chan_logic_t *c, bool active, int64_t t)
{
    bool running = active != c->cfg.status_invert;
    if (c->status_known && running == c->running) return;
    c->running = running;
    c->status_known = true;
    emit(c, running ? MES_READ_RUNNING : MES_READ_DOWN, t);
}

static void on_part(mes_chan_logic_t *c, bool good, int64_t t)
{
    if (c->cfg.status_mode == MES_SIGNAL_PRESENCE) {
        if (!c->running) {
            c->running = true;
            emit(c, MES_READ_RUNNING, t);
        }
        c->last_part_t = t;
    } else if (c->status_known && !c->running && !c->cfg.accept_production_while_down) {
        return; /* ProductionGate: a part signal while the machine is down is noise */
    }
    emit(c, good ? MES_READ_GOOD : MES_READ_SCRAP, t);
}

static void poll_roles(mes_chan_logic_t *c, int64_t now)
{
    int64_t at;
    if (c->cfg.status_di && c->cfg.status_mode == MES_STATUS_BIT && mes_debounce_poll(&c->status, now, &at)) on_status(c, c->status.stable, at);
    if (c->cfg.good_di && mes_debounce_poll(&c->good, now, &at) && c->good.stable) on_part(c, true, at);
    if (c->cfg.scrap_di && mes_debounce_poll(&c->scrap, now, &at) && c->scrap.stable) on_part(c, false, at);
}

void mes_chan_start(mes_chan_logic_t *c, const mes_chan_cfg_t *cfg, uint8_t levels, int64_t now, mes_emit_fn fn, void *ctx)
{
    memset(c, 0, sizeof *c);
    c->cfg = *cfg;
    c->emit = fn;
    c->ctx = ctx;
    c->running = true; /* ProductionGate starts as "running" */
#define LEVEL(di) ((di) >= 1 && (di) <= MES_DI_COUNT && ((levels >> ((di) - 1)) & 1))
    mes_debounce_init(&c->good, cfg->count_debounce_ms, LEVEL(cfg->good_di));
    mes_debounce_init(&c->scrap, cfg->count_debounce_ms, LEVEL(cfg->scrap_di));
    mes_debounce_init(&c->status, cfg->status_debounce_ms, LEVEL(cfg->status_di));
    if (cfg->status_mode == MES_SIGNAL_PRESENCE) {
        c->running = false;
        c->status_known = true;
        emit(c, MES_READ_DOWN, now);
    } else if (cfg->status_di) {
        on_status(c, LEVEL(cfg->status_di), now);
    }
#undef LEVEL
}

void mes_chan_edge(mes_chan_logic_t *c, uint8_t di, bool level, int64_t t)
{
    poll_roles(c, t); /* whatever became stable before this edge comes first */
    int64_t at;
    if (c->cfg.status_di == di && c->cfg.status_mode == MES_STATUS_BIT && mes_debounce_feed(&c->status, level, t, &at)) on_status(c, c->status.stable, at);
    if (c->cfg.good_di == di && mes_debounce_feed(&c->good, level, t, &at) && c->good.stable) on_part(c, true, at);
    if (c->cfg.scrap_di == di && mes_debounce_feed(&c->scrap, level, t, &at) && c->scrap.stable) on_part(c, false, at);
}

void mes_chan_poll(mes_chan_logic_t *c, int64_t now)
{
    poll_roles(c, now);
    if (c->cfg.status_mode == MES_SIGNAL_PRESENCE && c->running && now - c->last_part_t >= (int64_t)c->cfg.no_signal_timeout_ms) {
        c->running = false;
        emit(c, MES_READ_DOWN, c->last_part_t + c->cfg.no_signal_timeout_ms);
    }
}
