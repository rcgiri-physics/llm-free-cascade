// Compiled (never run) by `npm run check:types`, to catch index.d.ts drifting from the API.
import { LLMCascade, LLMCascadeError, GenerateResult, StreamResult, fileCooldownStore, discoverFreeModels } from '../src/index';
import { createServer } from '../src/server';

export async function typesStayUsable(signal: AbortSignal): Promise<void> {
  const cascade = new LLMCascade({
    keys: { groq: ['a', 'b'] },
    sticky: true,
    contextTokens: { groq: 8000 },
    cooldownStore: fileCooldownStore('cooldowns.json'),
    custom: { ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', keyless: true } },
  });

  const result: GenerateResult = await cascade.generate({ user: 'hi', temperature: 0, topP: 1, stop: 'END', seed: 1, signal });
  const model: string = result.model;
  const finish: string | undefined = result.finishReason;

  const streamed: StreamResult = await cascade.generate({ user: 'hi', stream: true });
  for await (const chunk of streamed.stream) console.log(chunk.length, model, finish);
  console.log(streamed.info.usage?.totalTokens, streamed.info.finishReason);

  await cascade.generate({ user: 'hi', stream: true, onRestart: ({ from, to, error }) => console.log(from, to, error) });
  console.log((await discoverFreeModels())[0]?.contextLength);

  const err = new LLMCascadeError();
  if (err.code === 'ABORTED') console.log('aborted');

  createServer({ cascade }).listen(0);
}
