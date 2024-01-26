import type { ChatParameters } from '../chat/chat'
import { dependentAbortController } from '../common/abortController'
import type { Message } from '../sourcegraph-api'
import type { CompletionGeneratorValue } from '../sourcegraph-api/completions/types'
import { createOllamaClient } from './ollama-client'

export async function* ollamaChat(
    messages: Message[],
    params: Partial<ChatParameters>,
    abortSignal?: AbortSignal
): AsyncGenerator<CompletionGeneratorValue> {
    const ollamaClient = createOllamaClient({ url: 'http://localhost:11434' })
    const model = params?.model?.replace('ollama/', '') ?? 'mixtral'
    console.log('XX', messages)
    const stream = ollamaClient.complete(
        {
            model,
            prompt: formatPrompt(model, messages),
            template: '{{.Prompt}}',
            options: {
                stop: [
                    '<|system|>',
                    '<|assistant|>',
                    '<|human|>',
                    '<|end|>',
                    ...(params.stopSequences || []),
                ],
                top_k: params.topK,
                top_p: params.topP,
                num_ctx: 8192,
                temperature: params.temperature,
                num_predict: params.maxTokensToSample,
                seed: 1337,
            },
        },
        dependentAbortController(abortSignal)
    )
    try {
        for await (const resp of stream) {
            yield { type: 'change', text: resp.completion }
        }
        yield { type: 'complete' }
    } catch (error) {
        yield { type: 'error', error: error instanceof Error ? error : new Error(error as any) }
    }
}

function formatPrompt(model: string, messages: Message[]): string {
    if (model.includes('starchat')) {
        return `<|system|>\n<|end|>\n${messages
            .map(m => `<|${m.speaker === 'assistant' ? 'assistant' : 'user'}|>\n${m.text}<|end|>`)
            .join('\n')}\n<|assistant|>`
    }
    return messages.map(x => x.text).join('\n\n')
}
