import { test } from 'node:test';
import assert from 'node:assert/strict';
import settings, { setSettings } from '../src/agent/settings.js';
import { getProtocolVersion, resolveConnectionOptions } from '../src/utils/mcdata.js';

test('minecraft-data advertises native Minecraft 26.2 protocol 776', () => {
    assert.equal(getProtocolVersion('26.2'), 776);
});

test('native connection selection preserves older-version compatibility', () => {
    setSettings({ minecraft_version: '1.21.6', host: 'server', port: 25565, auth: 'offline', connection_mode: 'native' });
    assert.deepEqual(resolveConnectionOptions('bot'), {
        username: 'bot', host: 'server', port: 25565, auth: 'offline', version: '1.21.6',
        checkTimeoutInterval: 60000,
    });
    setSettings({ minecraft_version: 'auto', host: 'server', port: 25565, auth: 'offline' });
});

test('ViaProxy selection is explicit and validates endpoint configuration', () => {
    setSettings({ minecraft_version: '1.21.6', connection_mode: 'viaproxy', via_proxy: { host: 'proxy.example', port: 25568 } });
    const options = resolveConnectionOptions('bot');
    assert.equal(options.host, 'proxy.example');
    assert.equal(options.port, 25568);
    assert.equal(options.viaProxy, true);
    assert.throws(() => resolveConnectionOptions('bot', { connection_mode: 'viaproxy', via_proxy: { host: '', port: 0 } }), /ViaProxy mode is enabled/);
    setSettings({ minecraft_version: 'auto', host: '127.0.0.1', port: 25565, auth: 'offline', connection_mode: 'native' });
});

test('26.2 fails clearly if gameplay data is absent rather than pretending support', async () => {
    const { initForVersion } = await import('../src/utils/mcdata.js');
    assert.throws(() => initForVersion('26.2'), /protocol 776.*no gameplay data set/i);
});

void settings;
