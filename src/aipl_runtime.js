export class ActorRuntime {
  constructor({ onLog, onActivity } = {}) {
    this.actors = new Map();
    this.queue = [];
    this.onLog = onLog ?? (() => {});
    this.onActivity = onActivity ?? (() => {});
    this.messageCount = 0;
    this.running = true;
  }

  register(name, actor) {
    actor.runtime = this;
    actor.name = name;
    this.actors.set(name, actor);
    this.log('AICE', `registered actor: ${name}`);
  }

  send(to, method, ...args) {
    this.queue.push({ to, method, args, sender: this.currentActor ?? 'system' });
    this.messageCount += 1;
  }

  async step(limit = 20) {
    if (!this.running) return;
    let n = 0;
    while (this.queue.length && n < limit) {
      const msg = this.queue.shift();
      const actor = this.actors.get(msg.to);
      if (!actor || typeof actor[msg.method] !== 'function') {
        this.log('AICE', `unhandled: ${msg.to}.${msg.method}`);
        n += 1;
        continue;
      }
      this.currentActor = msg.to;
      this.onActivity(msg.to);
      try {
        await actor[msg.method](...msg.args);
      } catch (error) {
        this.log(msg.to, `error: ${error.message}`);
      } finally {
        this.currentActor = null;
      }
      n += 1;
    }
  }

  log(actor, text) {
    this.onLog(actor, text);
  }
}

export class BaseActor {
  send(to, method, ...args) {
    this.runtime.send(to, method, ...args);
  }
  log(text) {
    this.runtime.log(this.name, text);
  }
}
