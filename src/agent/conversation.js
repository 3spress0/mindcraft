/**
 * conversation.js — resilient version that avoids circular top-level await.
 * sendBotChatToServer is injected lazily to break mindserver_proxy cycle.
 */

let settings = { chat_bot_messages: false };
let containsCommand = () => null;
let _sendBotChatToServer = null;

async function loadDeps() {
    try {
        const mod = await import('./settings.js');
        settings = mod.default || mod;
    } catch {}
    try {
        const mod = await import('./commands/index.js');
        containsCommand = mod.containsCommand || (() => null);
    } catch {}
    try {
        const mod = await import('./mindserver_proxy.js');
        _sendBotChatToServer = mod.sendBotChatToServer || (() => {});
    } catch {
        _sendBotChatToServer = () => {};
    }
}
void loadDeps();

function sendBotChatToServer(...args) {
    if (_sendBotChatToServer) return _sendBotChatToServer(...args);
    // Lazy fallback: try to load synchronously if not yet loaded
    import('./mindserver_proxy.js').then(mod => {
        _sendBotChatToServer = mod.sendBotChatToServer || (() => {});
        _sendBotChatToServer(...args);
    }).catch(() => {});
}

let agent;
let agent_names = [];
let agents_in_game = [];

class Conversation {
    constructor(name) {
        this.name = name;
        this.active = false;
        this.ignore_until_start = false;
        this.blocked = false;
        this.in_queue = [];
        this.inMessageTimer = null;
        this.inMessageGeneration = 0;
    }

    _clearInMessageTimer() {
        if (this.inMessageTimer)
            clearTimeout(this.inMessageTimer);
        this.inMessageTimer = null;
        this.inMessageGeneration++;
    }

    reset() {
        this.active = false;
        this.ignore_until_start = false;
        this._clearInMessageTimer();
        this.in_queue = [];
    }

    end() {
        this.active = false;
        this.ignore_until_start = true;
        this._clearInMessageTimer();
        this.in_queue = [];
        if (agent && agent.last_sender === this.name)
            agent.last_sender = null;
    }

    queue(message) {
        this.in_queue.push(message);
    }
}

const WAIT_TIME_START = 30000;
class ConversationManager {
    constructor() {
        this.convos = {};
        this.activeConversation = null;
        this.awaiting_response = false;
        this.connection_timeout = null;
        this.wait_time_limit = WAIT_TIME_START;
    }

    initAgent(a) {
        agent = a;
    }

    _getConvo(name) {
        if (!this.convos[name])
            this.convos[name] = new Conversation(name);
        return this.convos[name];
    }

    _startMonitor() {
        clearInterval(this.connection_monitor);
        let wait_time = 0;
        let last_time = Date.now();
        this.connection_monitor = setInterval(() => {
            if (!this.activeConversation) {
                this._stopMonitor();
                return;
            }
            let delta = Date.now() - last_time;
            last_time = Date.now();
            let convo_partner = this.activeConversation.name;

            if (this.awaiting_response && agent && agent.isIdle && agent.isIdle()) {
                wait_time += delta;
                if (wait_time > this.wait_time_limit) {
                    if (agent.handleMessage) agent.handleMessage('system', `${convo_partner} hasn't responded in ${this.wait_time_limit/1000} seconds, respond with a message to them or your own action.`);
                    wait_time = 0;
                    this.wait_time_limit*=2;
                }
            }
            else if (!this.awaiting_response){
                this.wait_time_limit = WAIT_TIME_START;
                wait_time = 0;
            }

            if (!this.otherAgentInGame(convo_partner) && !this.connection_timeout) {
                this.connection_timeout = setTimeout(() => {
                    if (this.otherAgentInGame(convo_partner)){
                        this._clearMonitorTimeouts();
                        return;
                    }
                    if (!agent || !agent.self_prompter || !agent.self_prompter.isPaused || !agent.self_prompter.isPaused()) {
                        this.endConversation(convo_partner);
                        if (agent && agent.handleMessage) agent.handleMessage('system', `${convo_partner} disconnected, conversation has ended.`);
                    }
                    else {
                        this.endConversation(convo_partner);
                    }
                }, 10000);
            }
        }, 1000);
    }

    _stopMonitor() {
        clearInterval(this.connection_monitor);
        this.connection_monitor = null;
        this._clearMonitorTimeouts();
    }

    _clearMonitorTimeouts() {
        this.awaiting_response = false;
        clearTimeout(this.connection_timeout);
        this.connection_timeout = null;
    }

    async startConversation(send_to, message) {
        const convo = this._getConvo(send_to);
        convo.reset();
        if (agent && agent.self_prompter && agent.self_prompter.isActive && agent.self_prompter.isActive()) {
            await agent.self_prompter.pause();
        }
        if (convo.active)
            return;
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
        this.sendToBot(send_to, message, true, false);
    }

    startConversationFromOtherBot(name) {
        const convo = this._getConvo(name);
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
    }

    sendToBot(send_to, message, start=false, open_chat=true) {
        if (!this.isOtherAgent(send_to)) {
            if (agent) console.warn(`${agent.name} tried to send bot message to non-bot ${send_to}`);
            return;
        }
        const convo = this._getConvo(send_to);
        if (settings.chat_bot_messages && open_chat && agent && agent.openChat)
            agent.openChat(`(To ${send_to}) ${message}`);
        if (convo.ignore_until_start)
            return;
        convo.active = true;
        const end = message.includes('!endConversation');
        const json = { 'message': message, start, end };
        this.awaiting_response = true;
        try {
            sendBotChatToServer(send_to, json);
        } catch {}
    }

    async receiveFromBot(sender, received) {
        const convo = this._getConvo(sender);
        if (convo.ignore_until_start && !received.start)
            return;
        if (this.inConversation() && !this.inConversation(sender)) {
            this.sendToBot(sender, `I'm talking to someone else, try again later. !endConversation(\"${sender}\")`, false, false);
            this.endConversation(sender);
            return;
        }
        if (received.start) {
            convo.reset();
            this.startConversationFromOtherBot(sender);
        }
        this._clearMonitorTimeouts();
        convo.queue(received);
        convo.inMessageGeneration++;
        if (agent && agent.self_prompter && agent.self_prompter.isActive && agent.self_prompter.isActive()){
            await agent.self_prompter.pause();
        }
        void _scheduleProcessInMessage(sender, received, convo);
    }

    responseScheduledFor(sender) {
        if (!this.isOtherAgent(sender) || !this.inConversation(sender))
            return false;
        const convo = this._getConvo(sender);
        return !!convo.inMessageTimer;
    }

    isOtherAgent(name) {
        return agent_names.some((n) => n === name);
    }

    otherAgentInGame(name) {
        return agents_in_game.some((n) => n === name);
    }

    updateAgents(agents) {
        agent_names = agents.map(a => a.name);
        agents_in_game = agents.filter(a => a.in_game).map(a => a.name);
    }

    getInGameAgents() {
        return agents_in_game;
    }

    inConversation(other_agent=null) {
        if (other_agent)
            return this.convos[other_agent]?.active;
        return Object.values(this.convos).some(c => c.active);
    }

    endConversation(sender) {
        if (this.convos[sender]) {
            this.convos[sender].end();
            if (this.activeConversation?.name === sender) {
                this._stopMonitor();
                this.activeConversation = null;
                if (agent && agent.self_prompter && agent.self_prompter.isPaused && agent.self_prompter.isPaused() && !this.inConversation()) {
                    void _resumeSelfPrompter();
                }
            }
        }
    }

    endAllConversations() {
        for (const sender in this.convos) {
            this.endConversation(sender);
        }
        if (agent && agent.self_prompter && agent.self_prompter.isPaused && agent.self_prompter.isPaused()) {
            void _resumeSelfPrompter();
        }
    }

    forceEndCurrentConversation() {
        if (this.activeConversation) {
            let sender = this.activeConversation.name;
            this.sendToBot(sender, '!endConversation(\"' + sender + '\")', false, false);
            this.endConversation(sender);
        }
    }
}

const convoManager = new ConversationManager();
export default convoManager;

const talkOverActions = ['stay', 'followPlayer', 'mode:'];
const fastDelay = 200;
const longDelay = 5000;
async function _scheduleProcessInMessage(sender, received, convo) {
    if (convo.inMessageTimer) {
        clearTimeout(convo.inMessageTimer);
        convo.inMessageGeneration++;
    }
    const pending = compileQueuedBotMessages(convo.in_queue);
    const decisionMessage = pending?.message || received.message || '';
    const otherAgentBusy = isOtherBotActionNotice(decisionMessage);

    const scheduleResponse = (delay) => {
        const generation = convo.inMessageGeneration;
        const timer = setTimeout(() => _processInMessageQueue(sender, convo, generation, timer), delay);
        convo.inMessageTimer = timer;
    };

    const currentAction = agent ? (agent.actions?.currentActionLabel || '') : '';
    const canTalkOver = talkOverActions.some(a => currentAction.includes(a));
    const agentBusy = Boolean(currentAction) || (agent && agent.isIdle && !agent.isIdle()) || (agent && (agent.active_message_handlers || 0) > 0);

    if (agentBusy && otherAgentBusy && !canTalkOver) {
        convo.in_queue = [];
        convo.inMessageTimer = null;
    }
    else if (otherAgentBusy) {
        scheduleResponse(longDelay);
    }
    else if (agentBusy && !canTalkOver) {
        if (!agent || !agent.prompter || !agent.prompter.promptShouldRespondToBot) {
            scheduleResponse(fastDelay);
            return;
        }
        const decisionGeneration = convo.inMessageGeneration;
        let shouldRespond = false;
        try {
            shouldRespond = await agent.prompter.promptShouldRespondToBot(
                `${sender}: ${_tagMessage(decisionMessage)}`,
                { cacheScope: 'botResponder' }
            );
        } catch { shouldRespond = false; }
        if (decisionGeneration !== convo.inMessageGeneration)
            return;
        if (agent) console.log(`${agent.name} decided to ${shouldRespond?'respond':'ignore'} ${sender}`);
        if (shouldRespond) {
            scheduleResponse(fastDelay);
        }
        else {
            convo.in_queue = [];
            convo.inMessageTimer = null;
        }
    }
    else {
        scheduleResponse(fastDelay);
    }
}

function isOtherBotActionNotice(message) {
    const text = String(message || '').trim();
    try {
        return Boolean(containsCommand(text) || /^\*used\s+\w+\*/.test(text) || /^State update:/i.test(text));
    } catch {
        return false;
    }
}

function _processInMessageQueue(name, expectedConvo=null, expectedGeneration=null, expectedTimer=null) {
    const convo = convoManager._getConvo(name);
    if (expectedConvo && convo !== expectedConvo)
        return false;
    if (expectedGeneration !== null && convo.inMessageGeneration !== expectedGeneration)
        return false;
    if (expectedTimer && convo.inMessageTimer !== expectedTimer)
        return false;
    const received = _compileInMessages(convo);
    if (!received?.message?.trim()) {
        convo.inMessageTimer = null;
        return false;
    }
    _handleFullInMessage(name, received);
    return true;
}

export function compileQueuedBotMessages(queue) {
    if (!queue.length)
        return null;
    const messages = queue.map(pack => pack.message ?? '');
    return {
        ...queue[queue.length - 1],
        start: queue.some(pack => pack.start),
        end: queue.some(pack => pack.end),
        message: messages.join('\n'),
    };
}

function _compileInMessages(convo) {
    const compiled = compileQueuedBotMessages(convo.in_queue);
    convo.in_queue = [];
    return compiled;
}

function _handleFullInMessage(sender, received) {
    if (agent) console.log(`${agent.name} responding to \"${received.message}\" from ${sender}`);
    const convo = convoManager._getConvo(sender);
    convo.active = true;
    let message = _tagMessage(received.message);
    if (received.end) {
        convoManager.endConversation(sender);
        message = `Conversation with ${sender} ended with message: \"${message}\"`;
        sender = 'system';
    }
    else if (received.start && agent)
        agent.shut_up = false;
    convo.inMessageTimer = null;
    if (agent && agent.handleMessage) agent.handleMessage(sender, message);
}

function _tagMessage(message) {
    return "(FROM OTHER BOT)\n" + message;
}

async function _resumeSelfPrompter() {
    await new Promise(resolve => setTimeout(resolve, 5000));
    if (agent && agent.self_prompter && agent.self_prompter.isPaused && agent.self_prompter.isPaused() && !convoManager.inConversation()) {
        agent.self_prompter.start();
    }
}
