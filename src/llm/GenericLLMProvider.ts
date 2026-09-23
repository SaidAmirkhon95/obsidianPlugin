import { requestUrl } from 'obsidian';
import { ILLMProvider, LLMResponse } from './ILLMProvider';

export class GenericLLMProvider implements ILLMProvider {
    private plugin: any; 

    constructor(plugin: any) {
        this.plugin = plugin;
    }

    private get settings() {
        if (!this.plugin || !this.plugin.settings) {
            throw new Error("GenericLLMProvider: Plugin settings are not initialized properly.");
        }
        return this.plugin.settings;
    }

    private getHeaders(apiKey: string) {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const cleanKey = apiKey ? apiKey.trim() : ""; 
        if (cleanKey !== "") {
            headers["Authorization"] = `Bearer ${cleanKey}`;
        }
        return headers;
    }

    private isOpenAI(url: string): boolean {
        if (!url) return false;
        return url.includes('openai') || url.includes('v1/chat/completions') || url.includes('v1/embeddings');
    }

    private async fetchWithAutoRefresh(url: string, payload: any, isStream: boolean) {
        // === FIX: Unterscheide zwischen Chat-Key und Embed-Key ===
        const isEmbed = url === this.settings.embedApiUrl;
        let currentKey = isEmbed ? this.settings.embedApiKey : this.settings.chatApiKey;
        
        let headers = this.getHeaders(currentKey);
        const isFraunhofer = url.includes("fraunhofer.de");

        const attempt = async (currentHeaders: any) => {
            if (isStream) {
                return await fetch(url, { method: "POST", headers: currentHeaders, body: JSON.stringify(payload) });
            } else {
                return await requestUrl({ url, method: "POST", headers: currentHeaders, body: JSON.stringify(payload), throw: false });
            }
        };

        let res = await attempt(headers);
        let status = isStream ? (res as Response).status : (res as any).status;

        if (status === 401) {
            if (isFraunhofer && this.plugin.refreshFraunhoferToken) {
                console.log("[LLM] 401 Unauthorized. Attempting Fraunhofer auto-refresh...");
                const refreshed = await this.plugin.refreshFraunhoferToken();
                if (refreshed) {
                    // Nach dem Refresh den neuen Key aus den Settings holen
                    currentKey = isEmbed ? this.settings.embedApiKey : this.settings.chatApiKey;
                    headers = this.getHeaders(currentKey);
                    res = await attempt(headers);
                    status = isStream ? (res as Response).status : (res as any).status;
                } else {
                    throw new Error("Fraunhofer Token abgelaufen. Bitte gehe in die Einstellungen und logge dich neu ein.");
                }
            } else {
                throw new Error("API-Key ungültig (401 Unauthorized). Bitte prüfe deinen Key in den Einstellungen.");
            }
        }

        if (status >= 400) throw new Error(`API returned ${status}`);
        return res;
    }

    async embedText(text: string): Promise<number[]> {
        const url = this.settings.embedApiUrl;
        const isOAI = this.isOpenAI(url);
        const payload = isOAI 
            ? { model: this.settings.embedModel, input: text }
            : { model: this.settings.embedModel, prompt: text };

        const res: any = await this.fetchWithAutoRefresh(url, payload, false);
        const data = res.json;
        return isOAI ? (data.data[0].embedding as number[]) : (data.embedding as number[]);
    }

    async processWithLLM(text: string): Promise<LLMResponse> {
        const url = this.settings.chatApiUrl;
        const isOAI = this.isOpenAI(url);
        const isOllamaChat = url.endsWith('/api/chat');
        
        let payload: any;
        if (isOAI || isOllamaChat) {
            payload = { model: this.settings.chatModel, messages: [{ role: "user", content: text }], stream: false };
        } else {
            payload = { model: this.settings.chatModel, prompt: text, stream: false };
        }

        const res: any = await this.fetchWithAutoRefresh(url, payload, false);
        const data = res.json;
        
        let content = "";
        if (isOAI) content = data?.choices?.[0]?.message?.content ?? "";
        else if (isOllamaChat) content = data?.message?.content ?? "";
        else content = data?.response ?? "";
        
        return {
            model: this.settings.chatModel,
            created_at: new Date().toISOString(),
            done: true,
            done_reason: isOAI ? (data?.choices?.[0]?.finish_reason ?? "stop") : "stop",
            message: { content: content }
        };
    }

    async *processWithLLMStream(text: string): AsyncGenerator<string> {
        const url = this.settings.chatApiUrl;
        const isOAI = this.isOpenAI(url);
        const isOllamaChat = url.endsWith('/api/chat');
        
        const isFraunhofer = url.includes("fraunhofer.de");
        
        let payload: any;
        if (isOAI || isOllamaChat) {
            payload = { model: this.settings.chatModel, messages: [{ role: "user", content: text }], stream: true };
        } else {
            payload = { model: this.settings.chatModel, prompt: text, stream: true };
        }
      
        console.groupCollapsed("[LLM][STREAM] Request");
        console.log("POST", url);
        console.groupEnd();

        if (isFraunhofer) {
            console.log("[LLM] Fraunhofer API erkannt. Überspringe Streaming wegen CORS...");
            payload.stream = false; 

            yield "*(Lade Antwort vom Fraunhofer-Server.)*\n\n";

            try {
                const res: any = await this.fetchWithAutoRefresh(url, payload, false);
                const data = res.json;
                
                let content = "";
                if (isOAI) content = data?.choices?.[0]?.message?.content ?? "";
                else if (isOllamaChat) content = data?.message?.content ?? "";
                else content = data?.response ?? "";

                if (content) yield "\n\n" + content; 
            } catch (err: any) {
                console.error("[LLM] Fraunhofer Chat Error:", err);
                yield `\n\n**Fehler:** ${err.message}`;
            }
            return; 
        }

        try {
            const res = await this.fetchWithAutoRefresh(url, payload, true) as Response;
            
            if (!res.body) throw new Error("No body in stream");
          
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
          
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
            
                if (isOAI) {
                    buf += decoder.decode(value, { stream: true });
                    let idx: number;
                    while ((idx = buf.indexOf("\n")) >= 0) {
                        const rawLine = buf.slice(0, idx);
                        buf = buf.slice(idx + 1);
                        const line = rawLine.trim();
                        if (!line || !line.startsWith("data:")) continue;
                        
                        const dataStr = line.slice("data:".length).trim();
                        if (dataStr === "[DONE]") return;
                        
                        try {
                            const obj = JSON.parse(dataStr);
                            const piece = obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.message?.content ?? "";
                            if (piece) yield piece;
                        } catch {}
                    }
                } else {
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n');
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const obj = JSON.parse(line);
                            const piece = isOllamaChat ? obj.message?.content : obj.response;
                            if (piece) yield piece;
                            if (obj.done) return;
                        } catch (e) {}
                    }
                }
            }
        } catch (error: any) {
            console.error("[LLM][STREAM] Fetch failed:", error);
            yield `\n\n**Fehler beim Streaming:** ${error.message}`;
        }
    }
}