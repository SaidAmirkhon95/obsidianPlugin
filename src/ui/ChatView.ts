import { App, Modal, Notice, TFile } from 'obsidian';
import { ItemView, WorkspaceLeaf } from 'obsidian';
import BachelorSaidPlugin from 'src/main';

export const CHAT_VIEW_TYPE = 'llama3-chat-view';

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
}

interface ExtraSummary {
    id: string; 
    title: string;
    metadata: { [key: string]: any };
    summary: string;
}

const EXTRA_CHUNK_SIZE = 16000;

class NoteSelectorModal extends Modal {
    private resolveFn: (selectedNotes: TFile[]) => void;
    private selected: Set<TFile> = new Set();
    private candidates: TFile[];
  
    constructor(app: App, candidates: TFile[], resolveFn: (selectedNotes: TFile[]) => void) {
      super(app);
      this.resolveFn = resolveFn;
      this.candidates = candidates;
    }
  
    onOpen() {
      const { contentEl } = this;
      contentEl.empty();
  
      contentEl.createEl('h2', { text: 'Add extra notes' });
  
      if (!this.candidates.length) {
        contentEl.createDiv({ text: 'No related papers found.' });
        const closeBtn = contentEl.createEl('button', { text: 'Close' });
        closeBtn.style.marginTop = '10px';
        closeBtn.onclick = () => this.close();
        return;
      }
  
      const hint = contentEl.createDiv({ text: 'Select related papers to include as extra context:' });
      hint.style.fontSize = '12px';
      hint.style.opacity = '0.8';
      hint.style.marginBottom = '8px';
  
      const actions = contentEl.createDiv();
      actions.style.display = 'flex';
      actions.style.gap = '8px';
      actions.style.marginBottom = '8px';
  
      const selectAllBtn = actions.createEl('button', { text: 'Select all' });
      const clearBtn = actions.createEl('button', { text: 'Clear' });
  
      const list = contentEl.createDiv();
      list.style.maxHeight = '320px';
      list.style.overflowY = 'auto';
      list.style.border = '1px solid var(--background-modifier-border)';
      list.style.borderRadius = '10px';
      list.style.padding = '8px';
  
      const rows: { file: TFile; checkbox: HTMLInputElement }[] = [];
  
      for (const note of this.candidates) {
        const row = list.createDiv();
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '10px';
        row.style.padding = '6px 4px';
        row.style.borderRadius = '8px';
  
        const checkbox = row.createEl('input', { type: 'checkbox' });
        checkbox.onchange = () => {
          if (checkbox.checked) this.selected.add(note);
          else this.selected.delete(note);
        };
  
        const label = row.createEl('div', { text: note.basename });
        label.style.flex = '1';
        label.style.fontSize = '13px';
  
        rows.push({ file: note, checkbox });
      }
  
      selectAllBtn.onclick = () => {
        for (const r of rows) {
          r.checkbox.checked = true;
          this.selected.add(r.file);
        }
      };
  
      clearBtn.onclick = () => {
        for (const r of rows) {
          r.checkbox.checked = false;
        }
        this.selected.clear();
      };
  
      const submitBtn = contentEl.createEl('button', { text: 'Add selected' });
      submitBtn.style.marginTop = '10px';
      submitBtn.onclick = () => {
        this.resolveFn(Array.from(this.selected));
        this.close();
      };
    }
  
    onClose() {
      this.contentEl.empty();
    }
}

export class ChatView extends ItemView {
    private messages: ChatMessage[] = [];
    private chatContainer!: HTMLDivElement;
    private inputEl!: HTMLInputElement;
    public modeSelect!: HTMLSelectElement;
    private noteListEl!: HTMLDivElement;
    private extraNotes: TFile[] = [];
    private saveCheckbox!: HTMLInputElement;
    private subtitleEl!: HTMLElement;

    private wikiToPlain(s: string): string {
        const t = String(s).trim();
        const m = t.match(/^\[\[(.*)\]\]$/);
        if (!m) return t.replace(/^"+|"+$/g, "").trim();
        const inner = m[1];
        const parts = inner.split("|");
        return (parts[parts.length - 1] ?? inner).replace(/^"+|"+$/g, "").trim();
    }

    constructor(leaf: WorkspaceLeaf, private plugin: BachelorSaidPlugin) {
        super(leaf);
    }

    async handleAddExtraNotes() {
        const currentFile = this.app.workspace.getActiveFile();
        if (!currentFile) return;

        let paperBasenames = await this.plugin.ragService.getRelatedPapersFromNote(currentFile);

        if (paperBasenames.length === 0) {
            const foundFiles = await this.plugin.ragService.findAndSaveRelatedPapers(currentFile, 10);
            paperBasenames = foundFiles.map((f: { basename: any; }) => f.basename);
        }

        const extraFiles: TFile[] = [];
        for (const name of paperBasenames) {
            const file = this.app.metadataCache.getFirstLinkpathDest(name, currentFile.path);
            if (file instanceof TFile) {
                extraFiles.push(file);
            }
        }

        this.extraNotes = extraFiles;
        
        if (extraFiles.length > 0) {
            new Notice(`${extraFiles.length} papers added to chat context.`);
        } else {
            new Notice("No relevant papers found to add.");
        }
    }

    private async summarizeExtras(): Promise<ExtraSummary[]> {
        const extras: ExtraSummary[] = [];

        for (const extra of this.extraNotes) {
            try {
                const text = await this.app.vault.read(extra);

                const extracted = await this.plugin.ragService.extractPDFTextFromNote(text);
                const contentToChunk = (extracted && extracted.length > 0) ? extracted : text;
                const cleaned = await this.plugin.ragService.preCleanText(contentToChunk);

                const chunks: string[] = [];
                for (let i = 0; i < cleaned.length; i += EXTRA_CHUNK_SIZE) {
                    chunks.push(cleaned.slice(i, i + EXTRA_CHUNK_SIZE));
                }

                const metadata = await this.plugin.ragService.extractCurrentNoteMetadata(text);

                if (chunks.length === 0) {
                    extras.push({ id: extra.path, title: extra.basename, metadata, summary: "" });
                    continue;
                }

                const perChunkSummaries: string[] = [];
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    const prefix = i === 0
                    ? `You are reading an academic paper. This is the first chunk (${i + 1}/${chunks.length}) of extra note ${extra.basename}. Summarize concisely.`
                    : `This is chunk ${i + 1}/${chunks.length} of extra note ${extra.basename}. Continue summarizing concisely.`;

                    const metaNote = (i === 0 && Object.keys(metadata).length)
                    ? `\n\n---\nTitle: ${metadata.title || "N/A"}\nAuthors: ${(metadata.authors || []).join(", ") || "N/A"}\nConference/Journal: ${metadata.conference || "N/A"}\nKeywords: ${Array.isArray(metadata.keywords) ? metadata.keywords.join(", ") : (metadata.keywords || "N/A")}\n---\n`
                    : "";

                    // GEÄNDERT: llmProvider aufrufen
                    const resp = await this.plugin.llmProvider.processWithLLM(`${prefix}${metaNote}\n\n${chunk}`);
                    perChunkSummaries.push(resp.message.content.trim());
                }

                const consolidatePrompt = `You are given several partial summaries from chunks of an academic paper. Combine them into one concise, cohesive summary paragraph.

    --- PARTIAL SUMMARIES ---
    ${perChunkSummaries.map((s, idx) => `Summary ${idx + 1}: ${s}`).join("\n\n")}
    --- END ---`;

                const finalSummaryResponse = await this.plugin.llmProvider.processWithLLM(consolidatePrompt);
                const finalSummary = finalSummaryResponse.message.content.trim();

                extras.push({ id: extra.path, title: extra.basename, metadata, summary: finalSummary });
            } catch (err) {
                console.warn(`Failed to summarize extra note ${extra?.basename}:`, err);
                extras.push({ id: extra.path, title: extra.basename, metadata: {}, summary: "" });
            }
        }

        return extras;
    }

    getViewType() { return CHAT_VIEW_TYPE; }
    getDisplayText() { return 'LLaMA3 Chat'; }
    getIcon() { return 'message-square'; }

    async onOpen() {
        const { containerEl } = this;
        containerEl.empty();

        const root = containerEl.createDiv({ cls: 'llm-chat-root' });
        Object.assign(root.style, {
          display: 'flex',
          flexDirection: 'column',
          height: '90%',
          gap: '10px',
          padding: '10px'
        });

        const header = root.createDiv({ cls: 'llm-chat-header' });
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px'
        });

        const titleWrap = header.createDiv();
        const title = titleWrap.createEl('div', { text: 'Ask your Notes' });
        Object.assign(title.style, {
            fontSize: '14px',
            fontWeight: '700',
            lineHeight: '1.1'
        });

        this.subtitleEl = titleWrap.createEl('div', { text: 'No active note' });
        Object.assign(this.subtitleEl.style, {
            fontSize: '11px',
            opacity: '0.75',
            marginTop: '2px',
            color: 'var(--text-accent)' 
        });

        const headerRight = header.createDiv({ cls: 'llm-chat-header-actions' });
        Object.assign(headerRight.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap'
        });

        const findRelatedBtn = headerRight.createEl('button', { text: 'Find Related Papers' });
        Object.assign(findRelatedBtn.style, {
          padding: '6px 10px',
          borderRadius: '8px',
          border: '1px solid var(--interactive-accent)',
          background: 'var(--interactive-accent)',
          color: 'var(--text-on-accent)',
          cursor: 'pointer'
        });
        findRelatedBtn.addEventListener('click', async () => {
          const currentFile = this.app.workspace.getActiveFile();
          if (!currentFile) {
            new Notice('Kein aktives Notizfenster gefunden.');
            return;
          }
          await this.plugin.ragService.runRelevanceAnalysis(currentFile);
        });
      
        const pickBtn = headerRight.createEl('button', { text: 'Add extra notes' });
        Object.assign(pickBtn.style, {
          padding: '6px 10px',
          borderRadius: '8px',
          border: '1px solid var(--background-modifier-border)',
          background: 'var(--background-secondary)',
          cursor: 'pointer'
        });

        const saveWrapper = headerRight.createDiv();
        Object.assign(saveWrapper.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            marginLeft: '8px',
            paddingLeft: '8px',
            borderLeft: '1px solid var(--background-modifier-border)', 
            fontSize: '11px',
            opacity: '0.85'
        });

        this.saveCheckbox = saveWrapper.createEl('input', { type: 'checkbox' });
        this.saveCheckbox.id = 'llm-save-chat';
        this.saveCheckbox.style.margin = '0';
        this.saveCheckbox.style.cursor = 'pointer';
        this.saveCheckbox.checked = false; 

        const saveLabel = saveWrapper.createEl('label', { text: 'Save Chat' });
        saveLabel.htmlFor = 'llm-save-chat';
        saveLabel.style.cursor = 'pointer';

        const controls = root.createDiv({ cls: 'llm-chat-controls' });
        Object.assign(controls.style, {
            display: 'none',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            flexWrap: 'wrap'
        });

        this.noteListEl = root.createDiv({ cls: 'llm-chat-extra-notes' });
        Object.assign(this.noteListEl.style, {
          display: 'flex',
          gap: '6px',
          flexWrap: 'wrap',
          alignItems: 'center',
          fontSize: '11px',
          opacity: '0.9'
        });
      
        const extraLabel = this.noteListEl.createEl('span', { text: 'Extra:' });
        Object.assign(extraLabel.style, { opacity: '0.75', marginRight: '4px' });
      
        const renderExtraChips = () => {
            while (this.noteListEl.childElementCount > 1) {
              this.noteListEl.lastElementChild?.remove();
            }
          
            if (!this.extraNotes.length) {
              const none = this.noteListEl.createEl('span', { text: 'None' });
              Object.assign(none.style, { opacity: '0.7' });
              return;
            }
          
            for (const f of this.extraNotes) {
              const chip = this.noteListEl.createDiv();
              Object.assign(chip.style, {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '2px 8px',
                borderRadius: '999px',
                border: '1px solid var(--background-modifier-border)',
                background: 'var(--background-secondary)',
                maxWidth: '100%',
                overflow: 'hidden',
                whiteSpace: 'nowrap'
              });
          
              const label = chip.createEl('span', { text: f.basename });
              Object.assign(label.style, { overflow: 'hidden', textOverflow: 'ellipsis' });
          
              const removeBtn = chip.createEl('span', { text: '×' });
              Object.assign(removeBtn.style, {
                cursor: 'pointer',
                opacity: '0.75',
                fontSize: '14px',
                lineHeight: '1',
                padding: '0 2px',
                borderRadius: '6px'
              });
          
              removeBtn.addEventListener('mouseenter', () => (removeBtn.style.opacity = '1'));
              removeBtn.addEventListener('mouseleave', () => (removeBtn.style.opacity = '0.75'));
          
              removeBtn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.extraNotes = this.extraNotes.filter(x => x.path !== f.path);
                renderExtraChips();
              });
            }
        };        
      
        pickBtn.onclick = async () => {
            const currentFile = this.app.workspace.getActiveFile();
            if (!currentFile) {
                new Notice("Kein aktives Notizfenster gefunden.");
                return;
            }
        
            const relatedTitlesRaw = await this.plugin.ragService.getRelatedPapersFromNote(currentFile);
            let candidates: TFile[] = [];
        
            if (relatedTitlesRaw.length > 0) {
                for (const title of relatedTitlesRaw) {
                    const file = this.app.metadataCache.getFirstLinkpathDest(title, currentFile.path);
                    if (file instanceof TFile) candidates.push(file);
                }
            }
        
            if (candidates.length === 0) {
                new Notice("Keine Liste in Notiz gefunden. Starte KI-Suche...");
                candidates = await this.plugin.ragService.findTopRelevantNotes(currentFile, 10);
            }
        
            if (candidates.length === 0) {
                new Notice("Keine relevanten Arbeiten gefunden.");
                return;
            }
        
            new NoteSelectorModal(this.app, candidates.slice(0, 10), (selected: TFile[]) => {
                if (selected && selected.length > 0) {
                    this.extraNotes = selected; 
                    renderExtraChips();         
                    new Notice(`${selected.length} Arbeiten zum Chat hinzugefügt.`);
                }
            }).open();
        };                            
      
        renderExtraChips();
      
        this.chatContainer = root.createDiv({ cls: 'llm-chat-container' });
        Object.assign(this.chatContainer.style, {
          flex: '1',
          overflowY: 'auto',
          border: '1px solid var(--background-modifier-border)',
          background: 'var(--background-primary)',
          borderRadius: '12px',
          padding: '10px'
        });
      
        const inputRow = root.createDiv({ cls: 'llm-chat-input-row' });
        Object.assign(inputRow.style, {
          display: 'flex',
          gap: '8px',
          alignItems: 'center'
        });
      
        this.inputEl = inputRow.createEl('input', { type: 'text', placeholder: 'Frage stellen…' });
      
        Object.assign(this.inputEl.style, {
          width: '100%',
          padding: '10px 12px',
          borderRadius: '10px',
          border: '1px solid var(--background-modifier-border)',
          background: 'var(--background-secondary)',
          fontSize: '13px'
        });
      
        const sendBtn = inputRow.createEl('button', { text: 'Send' });
        Object.assign(sendBtn.style, {
          padding: '10px 12px',
          borderRadius: '10px',
          border: '1px solid var(--background-modifier-border)',
          background: 'var(--background-secondary)',
          cursor: 'pointer',
          fontSize: '13px',
          whiteSpace: 'nowrap'
        });
      
        const send = async () => {
          const v = this.inputEl.value.trim();
          if (!v) return;
          await this.handleUserMessage(v);
        };
      
        this.inputEl.addEventListener('keydown', async (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            await send();
          }
        });

        this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
            this.updateActiveNoteHeader();
        }));
        
        this.updateActiveNoteHeader();
        sendBtn.onclick = () => send();
        this.renderMessages();
    }

    private updateActiveNoteHeader() {
        const file = this.app.workspace.getActiveFile();
        if (file) {
            this.subtitleEl.setText(file.basename);
            this.subtitleEl.setAttr('title', file.path); 
        } else {
            this.subtitleEl.setText("No active note");
        }
    }

    private renderMessages() {
        this.chatContainer.empty();
      
        for (const m of this.messages) {
          const isUser = m.role === 'user';
      
          const row = this.chatContainer.createDiv({ cls: 'llm-chat-row' });
          Object.assign(row.style, {
            display: 'flex',
            justifyContent: isUser ? 'flex-end' : 'flex-start',
            margin: '10px 0'
          });
      
          const wrap = row.createDiv();
          Object.assign(wrap.style, {
            maxWidth: '78%',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px'
          });
      
          const label = wrap.createDiv({ text: isUser ? 'Du' : 'Assistent' });
          Object.assign(label.style, {
            fontSize: '11px',
            opacity: '0.7',
            paddingLeft: isUser ? '0' : '2px',
            paddingRight: isUser ? '2px' : '0',
            textAlign: isUser ? 'right' : 'left'
          });
      
          const bubble = wrap.createDiv({ cls: isUser ? 'user-bubble' : 'assistant-bubble' });
          bubble.setText(m.content);
      
          Object.assign(bubble.style, {
            padding: '10px 12px',
            borderRadius: '14px',
            whiteSpace: 'pre-wrap',
            lineHeight: '1.35',
            border: '1px solid var(--background-modifier-border)',
            boxShadow: '0 1px 0 rgba(0,0,0,0.06)',
            background: isUser ? 'var(--interactive-accent)' : 'var(--background-secondary)',
            color: isUser ? 'var(--text-on-accent)' : 'var(--text-normal)'
          });
      
          if (isUser) {
            bubble.style.borderTopRightRadius = '6px';
          } else {
            bubble.style.borderTopLeftRadius = '6px';
          }
        }
      
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }
    
    private async summarizeCurrentNoteFromCurrentFile(): Promise<{ metadata: any; summary: string } | null> {
        const currentFile = this.app.workspace.getActiveFile();
        if (!currentFile) return null;
    
        try {
          const noteText = await this.app.vault.read(currentFile);
          const currentMetadata = await this.plugin.ragService.extractCurrentNoteMetadata(noteText);
    
          const extractedText = await this.plugin.ragService.extractPDFTextFromNote(noteText);
          const cleanedText = await this.plugin.ragService.preCleanText(extractedText);
    
          if (!cleanedText || cleanedText.trim().length === 0) {
            // GEÄNDERT: llmProvider aufrufen
            const fallback = await this.plugin.llmProvider.processWithLLM(`Summarize this note concisely:\n\n${noteText}`);
            return { metadata: currentMetadata, summary: fallback.message.content.trim() };
          }
    
          const maxChunk = 16000;
          const chunks: string[] = [];
          for (let i = 0; i < cleanedText.length; i += maxChunk) chunks.push(cleanedText.slice(i, i + maxChunk));
    
          const chunkSummaries: string[] = [];
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const prefix = i === 0
              ? `You are reading an academic paper. This is the first chunk (${i + 1}/${chunks.length}). Extract metadata if available, and summarize concisely.`
              : `This is chunk ${i + 1}/${chunks.length}. Continue summarizing concisely.`;
    
            const metaNote = (i === 0 && Object.keys(currentMetadata).length)
              ? `\n\n---\nTitle: ${currentMetadata.title || "N/A"}\nAuthors: ${(currentMetadata.authors || []).join(", ") || "N/A"}\nConference/Journal: ${currentMetadata.conference || "N/A"}\nKeywords: ${(currentMetadata.keywords || "N/A")}\n---\n`
              : '';
    
            const resp = await this.plugin.llmProvider.processWithLLM(`${prefix}${metaNote}\n\n${chunk}`);
            chunkSummaries.push(resp.message.content.trim());
          }
    
          const consolidatePrompt = `You are given several partial summaries from chunks of an academic paper. Combine them into one concise, cohesive summary paragraph.
    
    --- PARTIAL SUMMARIES ---
    ${chunkSummaries.map((s, idx) => `Summary ${idx + 1}: ${s}`).join('\n\n')}
    --- END ---`;
    
          const finalSummaryResponse = await this.plugin.llmProvider.processWithLLM(consolidatePrompt);
          const finalSummary = finalSummaryResponse.message.content.trim();
    
          return { metadata: currentMetadata, summary: finalSummary };
        } catch (e) {
          console.error("Error summarizing current note:", e);
          return null;
        }
    }
    
    private buildMultiPaperPrompt(userQuestion: string, papers: ExtraSummary[]): string {
        const paperBlock = papers.map((p, i) => {
          const md = p.metadata ?? {};
      
          const raw = md.authors ?? md.author; 
          const wikiAuthorsArr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
          const wikiAuthors = wikiAuthorsArr.map(a => String(a).trim()).filter(Boolean);
      
          const normAuthors = wikiAuthors.map(a => this.wikiToPlain(a)).filter(Boolean);
      
          const title = md.title ?? `[[${p.title}]]`; 
          const conf = md.conference ?? md.journal ?? "N/A";
          const keywords = Array.isArray(md.keywords) ? md.keywords.join(", ") : (md.keywords ?? "N/A");
          const summary = p.summary ?? "";
      
          return `=== PAPER ${i + 1} ===
      PaperID: ${p.id}
      FileName: ${p.title}
      Title: ${title}
      Authors: ${wikiAuthors.length ? wikiAuthors.join(", ") : "N/A"}
      Authors_normalized: ${normAuthors.length ? normAuthors.join(", ") : "N/A"}
      Venue: ${conf}
      Keywords: ${keywords}
      
      Summary:
      ${summary}`;
        }).join("\n\n");
      
        return `You are an academic assistant.
        Task:
        1) Scan ALL context sources [#1..#N] and extract the minimal quotes (1-3 sentences) that answer the question.
        2) Then write the final answer using those quotes.
        Rules:
        - Use ONLY the context.
        - If the answer is not present, say exactly what section is missing.
        - Cite sources like [#2] after supported sentences.

        --- CONTEXT ---
        ${paperBlock}
        --- END CONTEXT ---

        User question: ${userQuestion}

        First, extract evidence bullets with citations, then answer.`;

        }       
    
        private async handleUserMessage(text: string) {
            if (!text) return;
        
            const userMsg: ChatMessage = { role: 'user', content: text, timestamp: new Date().toISOString() };
            this.messages.push(userMsg);
            this.renderMessages();
            this.inputEl.value = '';
        
            const assistantMsg: ChatMessage = { role: 'assistant', content: '', timestamp: new Date().toISOString() };
            this.messages.push(assistantMsg);
            this.renderMessages();
        
            try {
            const currentFile = this.app.workspace.getActiveFile();
            if (!currentFile) {
                assistantMsg.content = "Kein aktives Dokument gefunden.";
                this.renderMessages();
                return;
            }
        
            let scopeFiles: TFile[] = [currentFile, ...this.extraNotes];
        
            const seen = new Set<string>();
            scopeFiles = scopeFiles.filter(f => (seen.has(f.path) ? false : (seen.add(f.path), true)));
        
            if (this.extraNotes.length > 0) {
                const extrasSummaries = await this.summarizeExtras();
                const currentPaper = await this.summarizeCurrentNoteFromCurrentFile();
                const papers: ExtraSummary[] = [];

                if (currentPaper) {
                    papers.push({
                      id: "CURRENT",
                      title: currentFile.basename,
                      metadata: currentPaper.metadata ?? {},
                      summary: currentPaper.summary ?? ""
                    });
                }

                extrasSummaries.forEach((p, idx) => {
                    papers.push({
                    ...p,
                    id: `EXTRA_${idx + 1}`
                    });
                });
              
                const finalPrompt = this.buildMultiPaperPrompt(text, papers);
                
                for await (const chunk of this.plugin.llmProvider.processWithLLMStream(finalPrompt)) {
                    assistantMsg.content += chunk;
                    this.renderMessages();
                }

                if (this.saveCheckbox && this.saveCheckbox.checked) {
                    await this.plugin.saveChatToNote(this.messages);
                    new Notice("Chat progress saved."); 
                }
                return;
            }                   
      
          const retrieved = await this.plugin.ragService.retrieveRelevantChunks(text, scopeFiles, this.plugin.settings.topK);
      
          if (retrieved.length === 0) {
            assistantMsg.content = "Ich habe keine indexierten Inhalte gefunden (oder der Kontext ist leer). Bitte indexiere zuerst die Notizen oder prüfe den PDF-Text Abschnitt.";
            this.renderMessages();
            return;
          }
      
          const finalPrompt = this.plugin.ragService.buildRagPrompt(text, retrieved);
      
          for await (const chunk of this.plugin.llmProvider.processWithLLMStream(finalPrompt)) {
            assistantMsg.content += chunk;
            this.renderMessages();
          }
        } catch (e) {
          assistantMsg.content += `\n\n[Error: ${e}]`;
          this.renderMessages();
        }
      
        if (this.saveCheckbox && this.saveCheckbox.checked) {
            await this.plugin.saveChatToNote(this.messages);
            new Notice("Chat progress saved."); 
        }
    }     

    async onClose() {
        this.containerEl.empty();
    }
}