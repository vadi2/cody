import * as vscode from 'vscode'

import { CodeCompletionsClient } from './client'
import { SupportedLanguage } from './tree-sitter/grammars'
import { createParser } from './tree-sitter/parser'

const EMPTY_RESULT = { items: [] }

export class FuzzyInlineCompletionItemProvider implements vscode.InlineCompletionItemProvider {
    constructor(private client: CodeCompletionsClient | null) {}
    public async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | null> {
        if (document.languageId !== 'typescript') {
            console.log({ languageId: document.languageId })
            return EMPTY_RESULT
        }
        if (!this.client) {
            console.log('No client provided to FuzzyInlineCompletionItemProvider')
            return EMPTY_RESULT
        }
        // const params: CodeCompletionsParams = {
        //     maxTokensToSample: 200,
        //     temperature: 0.5,
        //     stopSequences: [HUMAN_PROMPT, CLOSING_CODE_TAG],
        //     messages: [
        //         {
        //             speaker: 'human',
        //             text: `You are Anders Hejlsberg, the world's most senior TypeScript developer. You write code in between tags like this: ${OPENING_CODE_TAG}/* Code goes here */${CLOSING_CODE_TAG}.`,
        //         },
        //         {
        //             speaker: 'assistant',
        //             text: 'I write immaculate TypeScript code.',
        //         },
        //         {
        //             speaker: 'human',
        //             text: `The file you are writing is ${document.fileName}`,
        //         },
        //         {
        //             speaker: 'assistant',
        //             text: 'Acknowledged.',
        //         },
        //         {
        //             speaker: 'human',
        //             text: 'Rewrite this code to be cleaner, more efficient and add type safety: ' + document.getText(),
        //         },
        //         {
        //             speaker: 'assistant',
        //             text: `Here is the improved TypeScript code: ${OPENING_CODE_TAG}`,
        //         },
        //     ],
        // }
        // console.log(JSON.stringify(params, null, 2))
        // try {
        //     // const finalResponse = await this.client.complete(
        //     //     params,
        //     //     partialResponse => {
        //     //         console.log({ partialResponse })
        //     //     },
        //     //     this.signal
        //     // )
        //     // console.log('FinalResponse')
        //     // console.log('-------------')
        //     // console.log(finalResponse.completion)
        //     // return EMPTY_RESULT
        // } catch (error) {
        //     console.error('FuzzyInlineCompletionItemProvider failed', error)
        // }
        const parser = await createParser({ language: SupportedLanguage.TypeScript })
        if (!parser) {
            console.log('No parser available for TypeScript')
            return EMPTY_RESULT
        }
        console.log({ position })
        const query = parser.getLanguage().query(`
(call_expression
    function: (_) @qualifier
    arguments: (arguments (object) @object)
)
`)
        const tree = parser.parse(document.getText())
        const matches = query.matches(
            tree.rootNode,
            { row: position.line, column: position.character },
            { row: position.line, column: position.character }
        )

        console.log({ matches, text: document.getText(), node: tree.rootNode })

        for (const match of matches) {
            for (const capture of match.captures) {
                console.log({
                    capture: capture.name,
                    node: { start: capture.node.startPosition, end: capture.node.endPosition },
                })
            }
        }

        return EMPTY_RESULT
    }
}
