/**
 * mindserver_proxy.js — resilient version without top-level circular await.
 * socket.io-client, conversation, settings, full_state are loaded lazily.
 */

let io = null;
let _convoManager = null;
let _setSettings = () => {};
let _getFullState = () => ({});

async function loadIo() {
    if (io) return io;
    try {
        const mod = await import('socket.io-client');
        io = mod.io || mod.default?.io || mod.default || mod;
    } catch {
        io = null;
    }
    return io;
}

async function loadConvo() {
    if (_convoManager) return _convoManager;
    try {
        const mod = await import('./conversation.js');
        _convoManager = mod.default || mod;
    } catch {
        _convoManager = { receiveFromBot: () => {}, updateAgents: () => {} };
    }
    return _convoManager;
}

async function loadSettings() {
    try {
        const mod = await import('./settings.js');
        _setSettings = mod.setSettings || (() => {});
    } catch {}
}

async function loadFullState() {
    try {
        const mod = await import('./library/full_state.js');
        _getFullState = mod.getFullState || (() => ({}));
    } catch {}
}

void loadIo();
void loadConvo();
void loadSettings();
void loadFullState();

class MindServerProxy {
    constructor() {
        if (MindServerProxy.instance) {
            return MindServerProxy.instance;
        }
        this.socket = null;
        this.connected = false;
        this.agents = [];
        MindServerProxy.instance = this;
    }

    async connect(name, port) {
        if (this.connected) return;
        this.name = name;
        const ioFn = await loadIo();
        if (!ioFn) throw new Error('socket.io-client not available');
        this.socket = ioFn(`http://localhost:${port}`);

        await new Promise((resolve, reject) => {
            this.socket.on('connect', resolve);
            this.socket.on('connect_error', (err) => {
                console.error('Connection failed:', err);
                reject(err);
            });
        });

        this.connected = true;
        console.log(name, 'connected to MindServer');

        const convo = await loadConvo();

        this.socket.on('disconnect', () => {
            console.log('Disconnected from MindServer');
            this.connected = false;
            if (this.agent) {
                this.agent.cleanKill('Disconnected from MindServer. Killing agent process.');
            }
        });

        this.socket.on('chat-message', (agentName, json) => {
            convo.receiveFromBot(agentName, json);
        });

        this.socket.on('agents-status', (agents) => {
            this.agents = agents;
            convo.updateAgents(agents);
            if (this.agent?.task) {
                console.log(this.agent.name, 'updating available agents');
                this.agent.task.updateAvailableAgents(agents);
            }
        });

        this.socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            this.agent.cleanKill();
        });

        this.socket.on('stop-agent', () => {
            console.log(`Stopping agent ${this.name} by MindServer request`);
            this.agent.cleanKill('Stopped by MindServer.', 0);
        });

        this.socket.on('send-message', (data) => {
            try {
                this.agent.respondFunc(data.from, data.message);
            } catch (error) {
                console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }
        });

        this.socket.on('get-full-state', async (callback) => {
            try {
                await loadFullState();
                const state = _getFullState(this.agent);
                callback(state);
            } catch (error) {
                console.error('Error getting full state:', error);
                callback(null);
            }
        });

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Settings request timed out after 5 seconds'));
            }, 5000);

            this.socket.emit('get-settings', name, async (response) => {
                clearTimeout(timeout);
                if (response.error) {
                    return reject(new Error(response.error));
                }
                await loadSettings();
                _setSettings(response.settings);
                this.socket.emit('connect-agent-process', name);
                resolve();
            });
        });
    }

    setAgent(agent) {
        this.agent = agent;
    }

    getAgents() {
        return this.agents;
    }

    getNumOtherAgents() {
        return this.agents.length - 1;
    }

    login() {
        if (this.socket) this.socket.emit('login-agent', this.agent.name);
    }

    shutdown() {
        if (this.socket) this.socket.emit('shutdown');
    }

    getSocket() {
        return this.socket;
    }
}

export const serverProxy = new MindServerProxy();

export function sendBotChatToServer(agentName, json) {
    const sock = serverProxy.getSocket();
    if (sock) sock.emit('chat-message', agentName, json);
}

export function sendOutputToServer(agentName, message) {
    const sock = serverProxy.getSocket();
    if (sock) sock.emit('bot-output', agentName, message);
}

export function sendTraceEventToServer(agentName, event) {
    const socket = serverProxy.getSocket();
    if (socket?.connected) {
        socket.emit('agent-trace', agentName, event);
    }
}
