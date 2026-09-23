// src/services/RagService.ts
import { App, Notice, TFile, MarkdownView } from 'obsidian';
import * as yaml from "js-yaml";
import { RagIndex, VectorChunk } from '../types';
import type BachelorSaidPlugin from '../main';
import { DragAndDropModal } from '../ui/Modals';

export class RagService {
    public ragIndex: RagIndex | null = null;
    public ragIndexPath: string | null = null;
    private PAPERS_DIR = "01_papers";

    constructor(private plugin: BachelorSaidPlugin) {}

    async init() {
        const cfg = (this.plugin.app.vault as any).configDir ?? ".obsidian";
        this.ragIndexPath = `${cfg}/plugins/${this.plugin.manifest.id}/rag-index.json`;
        console.log("[RAG] ragIndexPath =", this.ragIndexPath);
        await this.loadRagIndex();
    }

    private get app(): App {
        return this.plugin.app;
    }

    private get settings() {
        return this.plugin.settings;
    }

    private get llmProvider() {
        return this.plugin.llmProvider;
    }

    // ==========================================
    // INDEX MANAGEMENT
    // ==========================================

    public async loadRagIndex() {
        console.log("[RAG][LOAD] reading:", this.ragIndexPath);
        const empty: RagIndex = { version: 1, embeddingModel: this.settings.embedModel, chunks: [] };
    
        try {
            if (!this.ragIndexPath) { this.ragIndex = empty; return; }
    
            const exists = await this.app.vault.adapter.exists(this.ragIndexPath);
            if (!exists) {
                this.ragIndex = empty;
                await this.saveRagIndex();
                return;
            }
            const raw = await this.app.vault.adapter.read(this.ragIndexPath);
            this.ragIndex = JSON.parse(raw) as RagIndex;
        } catch (e) {
            console.warn("Failed to load rag index, recreating:", e);
            this.ragIndex = empty;
            await this.saveRagIndex();
        }
    }
    
    public async saveRagIndex() {
        if (!this.ragIndexPath || !this.ragIndex) return;
        try {
            const folder = `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
            const folderExists = await this.app.vault.adapter.exists(folder);
            if (!folderExists) await this.app.vault.adapter.mkdir(folder);
    
            await this.app.vault.adapter.write(this.ragIndexPath, JSON.stringify(this.ragIndex));
        } catch (e) {
            console.error("Failed to save rag index:", e);
        }
    }

    private ensureRagIndex(): RagIndex {
        if (!this.ragIndex) {
            this.ragIndex = { version: 1, embeddingModel: this.settings.embedModel, chunks: [] };
        }
        return this.ragIndex;
    }

    // ==========================================
    // MATH & VECTORS
    // ==========================================

    private async sha256(input: string): Promise<string> {
        const enc = new TextEncoder();
        const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    
    private cosineSimilarity(a: number[], b: number[]): number {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        const denom = Math.sqrt(na) * Math.sqrt(nb);
        return denom === 0 ? 0 : dot / denom;
    }

    private mmrSelect(scored: {chunk: VectorChunk; score: number}[], k: number, lambda = 0.75) {
        const selected: {chunk: VectorChunk; score: number}[] = [];
        const remaining = [...scored];
    
        while (selected.length < k && remaining.length) {
            let bestIdx = 0;
            let bestVal = -Infinity;
    
            for (let i = 0; i < remaining.length; i++) {
                const cand = remaining[i];
                let maxSim = 0;
                for (const s of selected) {
                    const sim = this.cosineSimilarity(cand.chunk.embedding, s.chunk.embedding);
                    if (sim > maxSim) maxSim = sim;
                }
                const mmr = lambda * cand.score - (1 - lambda) * maxSim;
                if (mmr > bestVal) { bestVal = mmr; bestIdx = i; }
            }
            selected.push(remaining.splice(bestIdx, 1)[0]);
        }
        return selected;
    }

    // ==========================================
    // CHUNKING LOGIC
    // ==========================================

    private chunkText(text: string, chunkSize: number, overlap: number): string[] {
        const chunks: string[] = [];
        let i = 0;
        const t = text.trim();
        if (!t) return chunks;
    
        while (i < t.length) {
            const end = Math.min(i + chunkSize, t.length);
            const chunk = t.slice(i, end);
            chunks.push(chunk);
            if (end === t.length) break;
            i = Math.max(0, end - overlap);
        }
        return chunks;
    }

    private detectHeading(line: string): string | null {
        const t = (line ?? "").trim();
        if (t.length < 3) return null;
        
        const known = ["abstract", "introduction", "background", "related work", "method", "methods", "methodology", "approach", "experiments", "results", "discussion", "conclusion", "conclusions", "references", "bibliography", "appendix", "acknowledgements", "limitations"];
        const lower = t.toLowerCase();
        
        if (known.includes(lower)) return t;
        if (/^\d+(\.\d+)*\s+[A-Za-z].{2,80}$/.test(t)) return t;
        if (/^[A-Z][A-Z0-9\s\-:]{3,80}$/.test(t) && t.split(" ").length <= 10) return t;
        return null;
    }

    private packParagraphsIntoChunks(paragraphs: string[], chunkSize: number, overlap: number): string[] {
        const chunks: string[] = [];
        let cur = "";
        const pushCur = () => { const x = cur.trim(); if (x) chunks.push(x); cur = ""; };
    
        for (const p of paragraphs) {
            const para = (p ?? "").trim();
            if (!para) continue;
            if (para.length > chunkSize) {
                if (cur.trim()) pushCur();
                for (let i = 0; i < para.length; i += chunkSize) chunks.push(para.slice(i, i + chunkSize));
                continue;
            }
            if ((cur.length + para.length + 2) <= chunkSize) {
                cur += (cur ? "\n\n" : "") + para;
            } else {
                pushCur();
                cur = para;
            }
        }
        pushCur();
    
        if (overlap > 0 && chunks.length > 1) {
            const out: string[] = [];
            for (let i = 0; i < chunks.length; i++) {
                if (i === 0) { out.push(chunks[i]); continue; }
                const prev = out[out.length - 1];
                const tail = prev.slice(Math.max(0, prev.length - overlap));
                out.push((tail + "\n" + chunks[i]).trim());
            }
            return out;
        }
        return chunks;
    }
    
    private chunkTextBySections(text: string, chunkSize: number, overlap: number): { section: string; chunks: string[] }[] {
        const lines = (text ?? "").split("\n");
        const sections: { title: string; paras: string[] }[] = [];
        let currentTitle = "Preamble";
        let currentParas: string[] = [];
        let curPara = "";
    
        const flushPara = () => { const p = curPara.trim(); if (p) currentParas.push(p); curPara = ""; };
        const flushSection = () => {
            flushPara();
            if (currentParas.length) sections.push({ title: currentTitle, paras: currentParas });
            currentParas = [];
        };
    
        for (const line of lines) {
            const h = this.detectHeading(line);
            if (h && curPara.trim().length === 0) {
                flushSection();
                currentTitle = h;
                continue;
            }
            if (!line.trim()) { flushPara(); continue; }
            curPara += (curPara ? " " : "") + line.trim();
        }
        flushSection();
    
        return sections.map(sec => ({
            section: sec.title,
            chunks: this.packParagraphsIntoChunks(sec.paras, chunkSize, overlap),
        }));
    }


    //---------------------------------
    //---------------------------------
    // Datenaufbereitung & Indexierung
    //---------------------------------
    async indexNoteFile(file: TFile): Promise<void> {
        const idx = this.ensureRagIndex();
        const noteText = await this.app.vault.read(file);
    
        const extracted = await this.extractPDFTextFromNote(noteText);
        const contentToIndex = (extracted && extracted.length > 0) ? extracted : noteText;
        const cleaned = await this.preCleanText(contentToIndex);
        const mtime = file.stat.mtime;
    
        idx.chunks = idx.chunks.filter(c => c.filePath !== file.path); //Chunking nach Arten
    
        const md = await this.extractCurrentNoteMetadata(noteText); //Ein Chunk, der nur Metadaten enthält
        const metaTextRaw = this.buildMetadataChunkText(file, md);
        const metaText = this.cleanWikiLinks(metaTextRaw);
        
        if (metaText.trim()) {
            const hash = await this.sha256("META::" + metaText);
            const embedding = await this.llmProvider.embedText(metaText);
            idx.chunks.push({
                id: `${file.path}::META::${hash.slice(0, 12)}`, filePath: file.path, fileName: file.basename,
                chunkIndex: -2, chunkType: "meta", section: "Metadata", text: metaText, embedding, hash, mtime, updatedAt: new Date().toISOString()
            });
        }
    
        const lead = cleaned.slice(0, 6000); // Ein Chunk für Abstract bzw. Einleitung
        if (lead.trim()) {
            const hash = await this.sha256("LEAD::" + lead);
            const embedding = await this.llmProvider.embedText(lead);
            idx.chunks.push({
                id: `${file.path}::LEAD::${hash.slice(0, 12)}`, filePath: file.path, fileName: file.basename,
                chunkIndex: -1, chunkType: "lead", section: "Lead", text: lead, embedding, hash, mtime, updatedAt: new Date().toISOString()
            });
        }
    
        const sectioned = this.chunkTextBySections(cleaned, this.settings.chunkSize, this.settings.chunkOverlap); // Chunks anhand von erkannten Überschriften
        const allBodyChunks: { section: string; text: string }[] = [];
    
        for (const sec of sectioned) {
            for (const ch of sec.chunks) {
                const t = (ch ?? "").trim();
                if (t) allBodyChunks.push({ section: sec.section, text: t });
            }
        }
    
        if (allBodyChunks.length === 0) {
            const fallbackChunks = this.chunkText(cleaned, this.settings.chunkSize, this.settings.chunkOverlap);
            for (const ch of fallbackChunks) if (ch.trim()) allBodyChunks.push({ section: "Body", text: ch.trim() });
        }
    
        let bodyIndex = 0;
        for (const item of allBodyChunks) {
            const hash = await this.sha256(item.text); //Ein SHA-256-Hash verhindert, dass exakt gleiche Chunks doppelt verarbeitet werden.
            const embedding = await this.llmProvider.embedText(item.text); //Für jeden Chunk wird ein Vektor (Embedding) über den LLM-Provider erstellt.
            idx.chunks.push({
                id: `${file.path}::${bodyIndex}::${hash.slice(0, 12)}`, filePath: file.path, fileName: file.basename,
                chunkIndex: bodyIndex, chunkType: "section", section: item.section, text: item.text, embedding, hash, mtime, updatedAt: new Date().toISOString()
            });
            bodyIndex++;
        }
    
        idx.embeddingModel = this.settings.embedModel;
        await this.saveRagIndex(); //Alles wird lokal in einer JSON-Datei gespeichert.
    }

    //---------------------------------
    // Suche & Informationsabruf
    //---------------------------------
    async retrieveRelevantChunks(query: string, scopeFiles: TFile[], topK: number): Promise<VectorChunk[]> {
        const idx = this.ensureRagIndex();
    
        for (const f of scopeFiles) {
            const fileChunks = idx.chunks.filter(c => c.filePath === f.path);
            const newestIndexedMtime = fileChunks.reduce((mx, c) => Math.max(mx, c.mtime ?? 0), 0);
            if (fileChunks.length === 0 || f.stat.mtime > newestIndexedMtime) { //Zuerst prüft das System, ob die Dateien im Vault neuer sind als der Index, und indexiert sie bei Bedarf sofort neu.
                try { await this.indexNoteFile(f); } catch (e) { console.warn("Indexing failed", f.path, e); }
            }
        }		
    
        const scopePaths = new Set(scopeFiles.map(f => f.path));
        const candidates = idx.chunks.filter(c => scopePaths.has(c.filePath));
        if (!candidates.length) return [];
    
        const queryTerms = query.toLowerCase().split(/[\s\?.,;!]+/).filter(t => t.length >= 3 && !["what", "when", "where", "which", "with", "from", "that", "this", "have", "does", "been", "according"].includes(t));
        const qVec = await this.llmProvider.embedText(query);
    
        const scored = candidates.map(c => { // Das System berechnet die Kosinus-Ähnlichkeit zwischen der Frage und allen Chunks.
            let score = this.cosineSimilarity(qVec, c.embedding);
            const textLower = c.text.toLowerCase();
            let boost = 0;
            for (const term of queryTerms) if (textLower.includes(term)) boost += 1.0;
            return { chunk: c, score: score + boost };
        });
        
        scored.sort((a, b) => b.score - a.score);
        
        const candidatesForMMR = scored.slice(0, 50); 
        const top = this.mmrSelect(candidatesForMMR, topK, 0.5); // Die MMR-Auswahl wird verwendet, um die relevantesten Chunks auszuwählen, aber unterschiedlich zueinander.
    
        const byFile = new Map<string, VectorChunk[]>();
        for (const c of candidates) {
            if (!byFile.has(c.filePath)) byFile.set(c.filePath, []);
            byFile.get(c.filePath)!.push(c);
        }
        for (const arr of byFile.values()) arr.sort((a,b) => a.chunkIndex - b.chunkIndex);
    
        const expanded: VectorChunk[] = [];
        const seen = new Set<string>();
        const push = (c: VectorChunk) => { if (!seen.has(c.id)) { seen.add(c.id); expanded.push(c); } };
    
        for (const hit of top) { // Für jeden der ausgewählten Top-Chunks werden die benachbarten Chunks hinzugefügt, um den Kontext zu erweitern.
            const c = hit.chunk;
            const arr = byFile.get(c.filePath)!;
            const i = arr.findIndex(x => x.id === c.id);
            if (i > 0) push(arr[i - 1]); 
            push(c);                     
            if (i < arr.length - 1) push(arr[i + 1]); 
        }
    
        for (const f of scopeFiles) {
            const meta = idx.chunks.find(c => c.filePath === f.path && c.chunkType === "meta");
            if (meta && !seen.has(meta.id)) { seen.add(meta.id); expanded.unshift(meta); }
        }
    
        expanded.sort((a, b) => a.filePath !== b.filePath ? a.filePath.localeCompare(b.filePath) : a.chunkIndex - b.chunkIndex);
        return expanded;
    }

    //---------------------------------
    //Prompt-Erstellung & Generierung
    //---------------------------------
    buildRagPrompt(userQuestion: string, retrieved: VectorChunk[]): string {
        const MAX_TOTAL = 65000;
        let used = 0;
        const blocks: string[] = [];
        
        const sorted = [...retrieved].sort((a, b) => { //Die Chunks werden logisch sortiert
            if (a.chunkType === "meta") return -1;
            if (b.chunkType === "meta") return 1;
            if (a.filePath === b.filePath) return a.chunkIndex - b.chunkIndex;
            return a.filePath.localeCompare(b.filePath);
        });
    
        for (const c of sorted) {
            const header = `\n[SOURCE: ${c.fileName}${c.section ? ` (Section: ${c.section})` : ""}]\n`;
            const remain = MAX_TOTAL - used - header.length;
            if (remain <= 150) break;
            const snippet = c.text.length > remain ? c.text.slice(0, remain) + "..." : c.text;
            blocks.push(header + snippet);
            used += header.length + snippet.length;
        }
    
        return `You are an expert academic research assistant.
### INSTRUCTIONS:
1. Answer the user's question using ONLY the provided context snippets below.
2. The context contains snippets from different parts of a paper. Read ALL snippets before answering.
3. Synthesis is key: If the answer is split across multiple snippets, combine them.
4. Cite the source using the format [File Name].

--- CONTEXT START ---
${blocks.join("\n")}
--- CONTEXT END ---

User Question: ${userQuestion}
Answer:`;
    }

    // ==========================================
    // RELEVANCE & SIMILARITY LOGIC
    // ==========================================

    private async getSummaryEmbedding(file: TFile): Promise<{ file: TFile; summary: string; vec: number[] } | null> {
        const text = await this.app.vault.read(file);
        const summary = this.extractSummaryFromNoteText(text);
        if (!summary) return null;
        const trimmed = summary.length > 2500 ? summary.slice(0, 2500) : summary;
        const vec = await this.llmProvider.embedText(trimmed);
        return { file, summary: trimmed, vec };
    }
    
    async findRelatedPapersBySummarySimilarity(currentFile: TFile, limit = 10, minScore = 0.78): Promise<{ file: TFile; score: number }[]> {
        const current = await this.getSummaryEmbedding(currentFile);
        if (!current) { new Notice("Current note has no Summary section."); return []; }
    
        const allFiles = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(this.PAPERS_DIR) && f.path !== currentFile.path);
        const candidates: { file: TFile; score: number }[] = [];
    
        for (const f of allFiles) {
            try {
                const other = await this.getSummaryEmbedding(f);
                if (!other) continue;
                const score = this.cosineSimilarity(current.vec, other.vec);
                if (score >= minScore) candidates.push({ file: f, score });
            } catch (e) { /* ignore */ }
        }
        return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
    }
    
    async findAndSaveRelatedPapers(currentFile: TFile, limit = 10): Promise<TFile[]> {
        const relatedResults = await this.findRelatedPapersBySummarySimilarity(currentFile, limit);
        const relatedFiles = relatedResults.map(r => r.file);
        if (relatedFiles.length === 0) { new Notice("No relevant papers found."); return []; }
        await this.updateRelevantPapersBlock(currentFile, relatedFiles);
        return relatedFiles;
    }

    private async updateRelevantPapersBlock(file: TFile, related: TFile[]) {
        const text = await this.app.vault.read(file);
        const linksText = related.map(f => `> - [[${f.basename}]]`).join('\n');
        const newBlock = `> [!Relevant papers]\n${linksText}`;
        const blockRegex = /^\s*>\s*\[!Relevant papers\][\s\S]*?(?=\n(?!\s*>)[^\n]|\s*$)/im;
        
        let updatedText = blockRegex.test(text) ? text.replace(blockRegex, newBlock) : (text.includes("## Summary") ? text.replace("## Summary", `## Summary\n\n${newBlock}\n`) : newBlock + "\n\n" + text);
        await this.app.vault.modify(file, updatedText);
        new Notice("Relevant papers updated in note.");
    }

    async findTopRelevantNotes(currentFile: TFile, limit = 10): Promise<TFile[]> {
        const text = await this.app.vault.read(currentFile);
        const summaryMatch = text.match(/##\s*Summary\s*\n([\s\S]*?)(?:\n##|$)/i);
        if (!summaryMatch) { new Notice("No summary found."); return []; }
        
        const currentSummary = summaryMatch[1].trim();
        const allFiles = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(this.PAPERS_DIR)); 
        const otherSummaries: { file: TFile; title: string; summary: string }[] = [];
    
        for (const file of allFiles) {
            if (file.path === currentFile.path) continue;
            const t = await this.app.vault.read(file);
            const sm = t.match(/##\s*Summary\s*\n([\s\S]*?)(?:\n##|$)/i);
            if (sm) otherSummaries.push({ file, title: file.basename, summary: sm[1].trim() });
        }
    
        if (otherSummaries.length === 0) return [];
    
        const loadingModal = new DragAndDropModal(this.app, "Looking for relevant papers...");
        loadingModal.open();
    
        const prompt = `You are given one academic paper summary and a list of other paper summaries. Identify which other summaries are relevant. Return ONLY the titles, each on a new line. At most ${limit} titles.\n\nMain Summary:\n${currentSummary}\n\nOther Summaries:\n${otherSummaries.map(s => `Title: ${s.title}\nSummary: ${s.summary}`).join('\n\n')}`;
    
        try {
            const response = await this.llmProvider.processWithLLM(prompt);
            const relevantTitles = response.message.content.split('\n').map(l => l.replace(/^[\d\s\-\.\*]+/, '').replace(/["']/g, '').trim()).filter(Boolean);
            const matchedFiles: TFile[] = [];
            for (const title of relevantTitles) {
                const file = this.app.metadataCache.getFirstLinkpathDest(title, currentFile.path);
                if (file instanceof TFile) matchedFiles.push(file);
                else {
                    const fuzzy = allFiles.find(f => title.toLowerCase().includes(f.basename.toLowerCase()) || f.basename.toLowerCase().includes(title.toLowerCase()));
                    if (fuzzy) matchedFiles.push(fuzzy);
                }
            }
            return [...new Set(matchedFiles)].slice(0, limit);
        } finally {
            loadingModal.close();
        }
    }

    async runRelevanceAnalysis(currentFile: TFile) {
        const text = await this.app.vault.read(currentFile);
        const currentSummary = this.extractSummaryFromNoteText(text);
        if (!currentSummary) { new Notice("No summary found."); return; }
    
        const allFiles = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(this.PAPERS_DIR));
        const others: { file: TFile; title: string; summary: string }[] = [];
    
        for (const file of allFiles) {
            if (file.path === currentFile.path) continue;
            const t = await this.app.vault.read(file);
            const sum = this.extractSummaryFromNoteText(t);
            if (sum) others.push({ file, title: file.basename, summary: sum.length > 2500 ? sum.slice(0, 2500) : sum });
        }
    
        if (others.length === 0) return;
    
        const loadingModal = new DragAndDropModal(this.app, "Looking for relevant papers...");
        loadingModal.open();
    
        try {
            const candidates = others.slice(0, 60);
            const numbered = candidates.map((s, i) => `${i + 1}) Title: ${s.title}\nSummary: ${s.summary}`).join("\n\n");
            const prompt = `Identify relevant summaries. Return ONLY numbers. \n\nMain Summary:\n${currentSummary.slice(0, 3000)}\n\nOther Summaries:\n${numbered}`;
            const response = await this.llmProvider.processWithLLM(prompt);
            const nums = Array.from((response.message.content || "").matchAll(/\b(\d{1,3})\b/g)).map(m => parseInt(m[1], 10));
            const uniq = Array.from(new Set(nums)).filter(n => n >= 1 && n <= candidates.length).slice(0, 12);
            
            const relevantTitles = uniq.map(n => candidates[n - 1].title);
            const relatedBlock = `> [!Relevant papers]\n> ${relevantTitles.length ? relevantTitles.map(t => `[[${t}]]`).join("\n> ") : "None found."}`;
            
            const summaryIndex = text.search(/##\s*Summary/i);
            if (summaryIndex === -1) return;
            const beforeSummary = text.slice(0, summaryIndex).trimEnd().replace(/^\s*>\s*\[!Relevant papers\][\s\S]*?(?=\n(?!\s*>)[^\n]|\s*$)/im, "").trimEnd();
            await this.app.vault.modify(currentFile, `${beforeSummary}\n\n${relatedBlock}\n\n${text.slice(summaryIndex)}`);
            new Notice(`Relevant papers inserted (${relevantTitles.length}).`);
        } finally {
            loadingModal.close();
        }
    }

    async addRelevanceAnalysisButton(noteFile: TFile) {
        const text = await this.app.vault.read(noteFile);
        const metadataEndIndex = text.indexOf('##');
        if (metadataEndIndex === 0 || text.includes("Find Related Papers")) return;
        
        await this.app.vault.modify(noteFile, text.slice(0, metadataEndIndex) + `\n\n<button class="relevance-button">Find Related Papers</button>\n\n` + text.slice(metadataEndIndex));
        setTimeout(() => {
            const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
            const btn = mdView?.contentEl.querySelector('.relevance-button');
            if (btn) btn.addEventListener('click', () => this.runRelevanceAnalysis(noteFile));
        }, 500);
    }

    // ==========================================
    // TEXT HELPERS
    // ==========================================

    extractSummaryFromNoteText(noteText: string): string {
        const m = noteText.match(/##\s*Summary\s*\n([\s\S]*?)(?:\n##|$)/i);
        return m ? m[1].trim() : "";
    }

    async getRelatedPapersFromNote(noteFile: TFile): Promise<string[]> {
        const text = await this.app.vault.read(noteFile);
        const blockMatch = text.match(/^\s*>\s*\[!Relevant papers\][\s\S]*?(?=\n(?!\s*>)[^\n]|\s*$)/im);
        if (!blockMatch) return [];
        return Array.from(blockMatch[0].matchAll(/\[\[([^\]]+)\]\]/g)).map(m => m[1].split('|')[0].trim());
    }

    private buildMetadataChunkText(file: TFile, metadata: any): string {
        const clean = (val: any) => Array.isArray(val) ? val.map(v => this.cleanWikiLinks(String(v))).join(", ") : this.cleanWikiLinks(String(val ?? "N/A"));
        return [
            "=== METADATA ===", `Title: ${clean(metadata?.title ?? file.basename)}`, `Authors: ${clean(metadata?.authors ?? metadata?.author)}`,
            `Venue: ${clean(metadata?.conference ?? metadata?.journal)}`, `Keywords: ${clean(metadata?.keywords)}`, `Year: ${clean(metadata?.year)}`
        ].join("\n");
    }    

    private cleanWikiLinks(text: string): string { return text ? text.replace(/\[\[/g, "").replace(/\]\]/g, "") : ""; }

    async preCleanText(text: string): Promise<string> {
        let cleaned = text.replace(/\r\n|\r/g, "\n").replace(/([a-zA-Z])- *\n *([a-zA-Z])/g, "$1$2").replace(/\n{2,}/g, "\n\n").replace(/^\s*\d+\s*$/gm, "");
        cleaned = cleaned.replace(/^\s*(fig|figure|table|doi|arxiv|page|citation|see profile|reads|uploads|publications?|citations?)[:\s].*$/gim, "");
        cleaned = cleaned.replace(/(researchgate\.net|SEE PROFILE|READS|CITATIONS|uploaded by|downloads?|https?:\/\/[^\s]+)/gi, "");
        cleaned = cleaned.replace(/{.*?}@.*?\.\w{2,}/g, "").replace(/$$\d+(,\s*\d+)*$$/g, "").replace(/[ \t]{2,}/g, " ");
        return cleaned.split("\n").map(line => line.trim()).join("\n").trim();
    }

    async extractPDFTextFromNote(noteText: string): Promise<string> {
		const fullTextSectionRegex = /##\s*Full Text Extracted from PDF\s*\n([\s\S]*?)(?=\n##|$)/i;
		const match = noteText.match(fullTextSectionRegex);
		const raw = match ? match[1].trim() : "";
		return raw.replace(/^```[\s\S]*?\n/, "").replace(/\n```$/, "").trim();
	}

    async extractCurrentNoteMetadata(
		noteText: string,
		chunk1Summary?: string
	  ): Promise<{ [key: string]: any }> {
		const metadata: { [key: string]: any } = {};
	  
		// Normalize newlines
		noteText = noteText.replace(/\r\n/g, '\n');
	  
		// --- Try YAML Frontmatter ---
		const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---/;
		const frontmatterMatch = noteText.match(frontmatterRegex);
		if (frontmatterMatch) {
		  try {
			const data = yaml.load(frontmatterMatch[1]) as { [key: string]: any };
	  
			if (data.title) metadata.title = data.title;
			const rawAuthors = data.authors ?? data.author;
			if (rawAuthors) {
			  metadata.authors = Array.isArray(rawAuthors)
				? rawAuthors
				: String(rawAuthors).split(/,| and /).map((s: string) => s.trim());
			}
			if (data.conference || data.journal) {
			  metadata.conference = data.conference || data.journal;
			}
			if (data.keywords) {
			  metadata.keywords = Array.isArray(data.keywords)
				? data.keywords
				: data.keywords.split(/,|;|\s+/).map((s: string) => s.trim()).filter(Boolean);
			}
		  } catch (error) {
			console.warn("YAML parsing failed:", error);
		  }
		}
	  
		// --- Fallback Regex from raw note text ---
		if (!metadata.title) {
		  const titleMatch = noteText.match(/^\s*title\s*[:\-]\s*["']?(.+?)["']?\s*$/im);
		  if (titleMatch) metadata.title = titleMatch[1].trim();
		}
	  
		if (!metadata.authors) {
		  const authorsMatch = noteText.match(/^\s*authors?\s*[:\-]\s*["']?(.+?)["']?\s*$/im);
		  if (authorsMatch) {
			metadata.authors = authorsMatch[1].split(/,| and /).map(a => a.trim());
		  }
		}
	  
		if (!metadata.conference) {
		  const confMatch = noteText.match(/^\s*(conference|journal)\s*[:\-]\s*["']?(.+?)["']?\s*$/im);
		  if (confMatch) metadata.conference = confMatch[2].trim();
		}
	  
		if (!metadata.keywords) {
		  const keywordsMatch = noteText.match(/^\s*keywords?\s*[:\-]\s*(.+)$/im);
		  if (keywordsMatch) {
			metadata.keywords = keywordsMatch[1]
			  .split(/,|;|\s+/)
			  .map(k => k.trim())
			  .filter(Boolean);
		  }
		}
	  
		// --- Fallback: Try parsing from chunk1 summary ---
		if (chunk1Summary) {
		  const summaryMetadata: { [key: string]: any } = {};
	  
		  const titleMatch = chunk1Summary.match(/[*\-]\s*Title\s*[:\-]\s*(.+)/i);
		  if (titleMatch) summaryMetadata.title = titleMatch[1].trim();
	  
		  const authorsBlockMatch = chunk1Summary.match(/[*\-]\s*Authors\s*[:\-]\s*((?:.|\n)*?)(?:[*\-]\s|\n\s*\*\*|$)/i);
		  if (authorsBlockMatch) {
			const raw = authorsBlockMatch[1]
			  .split("\n")
			  .map(line => line.replace(/^[-*•\d.\s]+/, '').trim())
			  .filter(line => !!line && !line.toLowerCase().includes("affiliation"));
			if (raw.length > 0) summaryMetadata.authors = raw;
		  }
	  
		  const confMatch = chunk1Summary.match(/[*\-]\s*(Conference|Journal)\s*[:\-]\s*(.+)/i);
		  if (confMatch) summaryMetadata.conference = confMatch[2].trim();
	  
		  const keywordsMatch = chunk1Summary.match(/[*\-]\s*Keywords\s*[:\-]\s*(.+)/i);
		  if (keywordsMatch) {
			summaryMetadata.keywords = keywordsMatch[1]
			  .split(/,|;|\s+/)
			  .map(k => k.trim())
			  .filter(Boolean);
		  }
	  
		  // Merge summary metadata only if main source is missing
		  if (!metadata.title && summaryMetadata.title) metadata.title = summaryMetadata.title;
		  if (!metadata.authors && summaryMetadata.authors) metadata.authors = summaryMetadata.authors;
		  if (!metadata.conference && summaryMetadata.conference) metadata.conference = summaryMetadata.conference;
		  if (!metadata.keywords && summaryMetadata.keywords) metadata.keywords = summaryMetadata.keywords;
		}
	  
		// Log if incomplete
		if (!metadata.title || !metadata.authors || !metadata.conference) {
		  console.warn("Partial metadata extracted:", metadata);
		}
	  
		return metadata;
	}

}