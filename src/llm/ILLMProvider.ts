export interface LLMResponse {
    model: string;
    created_at: string;
    done: boolean;
    done_reason: string;
    message: {
        content: string;
        role?: string;
    };
}

export interface ILLMProvider {
    processWithLLM(text: string): Promise<LLMResponse>;
    processWithLLMStream(text: string): AsyncGenerator<string>;
    embedText(text: string): Promise<number[]>;
}