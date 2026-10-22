import type { ChatClient, ChatMessage, SimulatedUserSpec } from '../core/types.ts';

/** What the simulated user writes when its goal is reached or can't be reached: the conversation ends there. */
export const stopToken = '<<DONE>>';

/**
 * A second model that plays the user of a conversational task with a fixed persona and goal. It sees the conversation from
 * the user's side (its own messages as `assistant`, the agent's as `user`) and answers with the next message, or with
 * the stop token once the goal is reached or can't be reached.
 *
 * How it combines with a task's fixed turns: the harness sends the fixed turns first and tells the simulated user about
 * each one and the agent's reply (`heard`), so it sees the whole conversation. Its own first message is then
 * `firstMessage` when the spec sets one (with or without fixed turns before it), else the model writes it.
 */
export class SimulatedUser {
  private readonly spec: SimulatedUserSpec;
  private readonly client: ChatClient;
  private readonly model: string | undefined;
  private readonly history: ChatMessage[] = [];
  /** Whether the simulated user has had its first turn (`firstMessage` or the model's). */
  private opened = false;

  constructor(spec: SimulatedUserSpec, client: ChatClient, model?: string) {
    this.spec = spec;
    this.client = client;
    this.model = model;
  }

  private system(): string {
    return [
      'You play the user of a software assistant in a test. Stay in your role; never say you are a model or a test.',
      `Persona: ${this.spec.persona}`,
      `Your goal: ${this.spec.goal}`,
      'Write only your next message to the assistant, short, as this person would type it, in the language of the persona.',
      "Answer the assistant's questions with what your persona knows. Do not invent new goals.",
      `When your goal is reached, or the assistant says it cannot help, write only ${stopToken}.`,
    ].join('\n');
  }

  /** A fixed turn the user sent before the simulated user took over, and the agent's reply to it. */
  heard(turn: string, agentReply: string): void {
    this.history.push({ role: 'assistant', content: turn }, { role: 'user', content: agentReply });
  }

  /**
   * The user's next message after the agent's reply (null when the reply was already `heard`, or at the start), or null
   * when the user stops. The first message is `firstMessage` when the spec sets one.
   */
  async next(agentReply: string | null, signal?: AbortSignal): Promise<string | null> {
    if (agentReply !== null) this.history.push({ role: 'user', content: agentReply });
    if (!this.opened) {
      this.opened = true;
      if (this.spec.firstMessage) {
        this.history.push({ role: 'assistant', content: this.spec.firstMessage });
        return this.spec.firstMessage;
      }
    }
    const response = await this.client.complete({
      model: this.model,
      messages: [
        { role: 'system', content: this.system() },
        ...(this.history.length === 0
          ? [
              {
                role: 'user' as const,
                content: '(The conversation starts. Write your first message.)',
              },
            ]
          : this.history),
      ],
      temperature: 0.3,
      signal,
    });
    const text = response.text.trim();
    if (text === '' || text.includes(stopToken)) return null;
    this.history.push({ role: 'assistant', content: text });
    return text;
  }
}
