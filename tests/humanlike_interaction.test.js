import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import settings from '../settings.js';
import {
    getInteractionConfig,
    interactionActive,
    focusOn,
    pause,
    naturalEquip
} from '../src/agent/humanlike/interaction.js';
import { createPersonality } from '../src/agent/humanlike/personality.js';

function mockBot(extra = {}) {
    const looks = [];
    return {
        looks,
        entity: { position: new Vec3(0, 64, 0) },
        look: async (yaw, pitch, force) => { looks.push({ yaw, pitch, force }); },
        equipCalls: [],
        equip: async (item, dest) => { },
        modes: { isOn: () => false },
        ...extra
    };
}

describe('humanlike interaction config', () => {
    it('has sane bounded defaults', () => {
        const cfg = getInteractionConfig();
        for (const key of ['dig_pause_ms', 'place_pause_ms', 'equip_pause_ms', 'window_pause_ms', 'post_action_pause_ms', 'focus_dwell_ms']) {
            const [lo, hi] = cfg[key];
            assert.ok(Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi >= lo && hi <= 1000, `${key} bounds sane`);
        }
        assert.equal(typeof cfg.focus_offset, 'number');
    });

    it('interactionActive respects gates', () => {
        const bot = mockBot();
        assert.equal(interactionActive(bot), true);
        assert.equal(interactionActive(mockBot({ _humanlike_off: true })), false);
        assert.equal(interactionActive(mockBot({ modes: { isOn: (m) => m === 'cheat' } })), false);
        // bots without look() (mocks/tests) stay deterministic
        const bare = { entity: { position: new Vec3(0, 0, 0) } };
        assert.equal(interactionActive(bare), false);

        // master switch via settings
        const saved = settings.humanlike.interaction.enabled;
        try {
            settings.humanlike.interaction.enabled = false;
            assert.equal(interactionActive(mockBot()), false);
        } finally {
            settings.humanlike.interaction.enabled = saved;
        }
    });
});

describe('humanlike focus and pauses', () => {
    it('focusOn glances at the block center with bounded dwell', async () => {
        const bot = mockBot();
        const personality = createPersonality({ name: 'Miner' });
        const res = await focusOn(bot, new Vec3(2, 64, 2), personality);
        assert.ok(res, 'focus should happen when active');
        assert.equal(bot.looks.length, 1);
        assert.equal(bot.looks[0].force, false);
        const cfg = getInteractionConfig();
        const [lo, hi] = cfg.focus_dwell_ms;
        assert.ok(res.dwellMs >= lo * 0.6 - 1 && res.dwellMs <= hi * 1.4 + 1);
    });

    it('focusOn is a no-op when gated off', async () => {
        const bot = mockBot({ _humanlike_off: true });
        const res = await focusOn(bot, new Vec3(1, 64, 1), createPersonality({ name: 'x' }));
        assert.equal(res, null);
        assert.equal(bot.looks.length, 0);
    });

    it('pause stays inside the configured envelope per kind', async () => {
        const bot = mockBot();
        const personality = createPersonality({ name: 'Pacer', overrides: { pace: 1 } });
        const cfg = getInteractionConfig();
        for (const kind of ['dig', 'place', 'equip', 'window', 'post']) {
            const key = kind === 'post' ? 'post_action_pause_ms' : `${kind}_pause_ms`;
            const [lo, hi] = cfg[key];
            const ms = await pause(bot, personality, kind);
            assert.ok(ms >= lo && ms <= hi, `${kind}: ${ms} outside [${lo},${hi}]`);
        }
    });

    it('pause returns 0 when gated off', async () => {
        const bot = mockBot({ _humanlike_off: true });
        const ms = await pause(bot, createPersonality({ name: 'x' }), 'dig');
        assert.equal(ms, 0);
    });

    it('naturalEquip equips with a bounded swap pause', async () => {
        let equipped = null;
        const bot = mockBot({ equip: async (item) => { equipped = item; } });
        const personality = createPersonality({ name: 'Eq', overrides: { pace: 0.6 } });
        const ok = await naturalEquip(bot, 'iron_pickaxe', personality);
        assert.equal(ok, true);
        assert.equal(equipped, 'iron_pickaxe');
    });

    it('naturalEquip falls back to plain equip when gated off', async () => {
        let equipped = null;
        const bot = mockBot({ _humanlike_off: true, equip: async (item) => { equipped = item; } });
        await naturalEquip(bot, 'stone_axe', null);
        assert.equal(equipped, 'stone_axe');
    });
});
