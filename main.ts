import { App, MarkdownView,	Modal, Notice, Plugin, TFile } from 'obsidian';
import { getDocument, GlobalWorkerOptions, PDFDocumentProxy } from 'pdfjs-dist';
import * as yaml from "js-yaml";
import { ItemView, WorkspaceLeaf } from 'obsidian';

export const CHAT_VIEW_TYPE = 'llama3-chat-view';

GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.0.375/pdf.worker.mjs";

interface PDFItem {
	str: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

// Kleine Hilfsfunktion um "Müll"-Zeichen auszufiltern
function isMostlyNoise(str: string): boolean {
    return !str || str.trim().length === 0 || (str.length < 3 && !/^[a-zA-Z0-9]$/.test(str));
}

interface MyPluginSettings {
	mySetting: string;
	embeddingProvider: "ollama";
	embeddingModel: string;  
	topK: number;
	chunkSize: number;
	chunkOverlap: number;
	openaiApiKey: string;
	groqApiKey: string;
	modelChat: string;
	modelEmbed: string;
}  

// --- RAG types ---
type Role = 'user' | 'assistant';

interface VectorChunk {
	id: string;
	filePath: string;
	fileName: string;
	chunkIndex: number;
  
	// ✅ NEW
	chunkType?: "meta" | "lead" | "section" | "body";
	section?: string;
	mtime?: number; // file.stat.mtime beim Indexieren
  
	text: string;
	embedding: number[];
	hash: string;
	updatedAt: string;
}  

interface RagIndex {
  version: number;
  embeddingModel: string;
  chunks: VectorChunk[];
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
	embeddingProvider: "ollama",
	embeddingModel: "nomic-embed-text",
	topK: 6,
	chunkSize: 2000,
	chunkOverlap: 250,
	openaiApiKey: "",
	groqApiKey: "",
	modelChat: "llama-3.1-8b-instant",
	modelEmbed: "text-embedding-3-small",
};
	

interface Llama3Response {
	model: string;
	created_at: string;
	done: boolean;
	done_reason: string;
	eval_count?: number;
	eval_duration?: number;
	load_duration?: number;
	message: {
		content: string;
		role?: string;
	};
	prompt_eval_count?: number;
	prompt_eval_duration?: number;
	total_duration?: number;
	[key: string]: any;
}

interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	timestamp: string;
}

interface ExtraSummary {
	id: string; // ✅ neu
	title: string;
	metadata: { [key: string]: any };
	summary: string;
}

const EXTRA_CHUNK_SIZE = 16000;

export class ChatView extends ItemView {
	private messages: ChatMessage[] = [];
	private chatContainer!: HTMLDivElement;
	private inputEl!: HTMLInputElement;
	public modeSelect!: HTMLSelectElement;
	private noteListEl!: HTMLDivElement;
	private extraNotes: TFile[] = [];
	private wikiToPlain(s: string): string {
		// [[A|B]] -> B, [[B]] -> B, sonst trim
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

		// 1. Bereits existierende Links aus dem Callout-Block lesen
		let paperBasenames = await this.plugin.getRelatedPapersFromNote(currentFile);

		// 2. Falls der Block leer ist, neue Suche im Plugin triggern (Punkt 3)
		if (paperBasenames.length === 0) {
			const foundFiles = await this.plugin.findAndSaveRelatedPapers(currentFile, 10);
			paperBasenames = foundFiles.map(f => f.basename);
		}

		// 3. Basenames in TFiles auflösen
		const extraFiles: TFile[] = [];
		for (const name of paperBasenames) {
			// Sucht die Datei im Vault basierend auf dem Namen im Link
			const file = this.app.metadataCache.getFirstLinkpathDest(name, currentFile.path);
			if (file instanceof TFile) {
				extraFiles.push(file);
			}
		}

		// 4. Den State der View aktualisieren (Punkt 3)
		this.extraNotes = extraFiles;
		
		// UI Feedback
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

		const extracted = await this.plugin.extractPDFTextFromNote(text);
		const contentToChunk = (extracted && extracted.length > 0) ? extracted : text;
		const cleaned = await this.plugin.preCleanText(contentToChunk);

		const chunks: string[] = [];
		for (let i = 0; i < cleaned.length; i += EXTRA_CHUNK_SIZE) {
			chunks.push(cleaned.slice(i, i + EXTRA_CHUNK_SIZE));
		}

		const metadata = await this.plugin.extractCurrentNoteMetadata(text);

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

			const resp = await this.plugin.processWithLlama3(`${prefix}${metaNote}\n\n${chunk}`);
			perChunkSummaries.push(resp.message.content.trim());
		}

		const consolidatePrompt = `You are given several partial summaries from chunks of an academic paper. Combine them into one concise, cohesive summary paragraph.

	--- PARTIAL SUMMARIES ---
	${perChunkSummaries.map((s, idx) => `Summary ${idx + 1}: ${s}`).join("\n\n")}
	--- END ---`;

		const finalSummaryResponse = await this.plugin.processWithLlama3(consolidatePrompt);
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

		// Root wrapper
		const root = containerEl.createDiv({ cls: 'llm-chat-root' });
		Object.assign(root.style, {
		  display: 'flex',
		  flexDirection: 'column',
		  height: '90%',
		  gap: '10px',
		  padding: '10px'
		});

		// Header
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

		const subtitle = titleWrap.createEl('div', { text: '' });
		Object.assign(subtitle.style, {
			fontSize: '11px',
			opacity: '0.75',
			marginTop: '2px'
		});

		// Rechtsbereich für Aktionen
		const headerRight = header.createDiv({ cls: 'llm-chat-header-actions' });
		Object.assign(headerRight.style, {
			display: 'flex',
			alignItems: 'center',
			gap: '8px',
			flexWrap: 'wrap'
		});

		// Find Related Papers (primary)
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
		  await this.plugin.runRelevanceAnalysis(currentFile);
		});
	  
		// Add extra notes (secondary)
		const pickBtn = headerRight.createEl('button', { text: 'Add extra notes' });
		Object.assign(pickBtn.style, {
		  padding: '6px 10px',
		  borderRadius: '8px',
		  border: '1px solid var(--background-modifier-border)',
		  background: 'var(--background-secondary)',
		  cursor: 'pointer'
		});

		// Controls row
		const controls = root.createDiv({ cls: 'llm-chat-controls' });
		Object.assign(controls.style, {
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'space-between',
			gap: '10px',
			flexWrap: 'wrap'
		});

		const left = controls.createDiv();
		Object.assign(left.style, {
			display: 'flex',
			gap: '8px',
			alignItems: 'center',
			flexWrap: 'wrap'
		});

		const modeLabel = left.createEl('div', { text: 'Context' });
		Object.assign(modeLabel.style, { fontSize: '12px', opacity: '0.8' });

		this.modeSelect = left.createEl('select');
		this.modeSelect.appendChild(new Option('Current note', 'currentNote'));
		this.modeSelect.appendChild(new Option('Folder (all notes here)', 'multiNote'));
		this.modeSelect.value = 'currentNote';
		Object.assign(this.modeSelect.style, {
			fontSize: '12px',
			padding: '4px 8px',
			borderRadius: '8px',
			border: '1px solid var(--background-modifier-border)',
			background: 'var(--background-secondary)'
		});
		// ✅ Hide from UI but keep in DOM for logic
		modeLabel.style.display = 'none';
		this.modeSelect.style.display = 'none';
		controls.style.display = 'none'; // optional: hides the whole row gap

		// Extra notes chips line
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
			// remove everything except the first label
			while (this.noteListEl.childElementCount > 1) {
			  this.noteListEl.lastElementChild?.remove();
			}
		  
			if (!this.extraNotes.length) {
			  const none = this.noteListEl.createEl('span', { text: 'None' });
			  Object.assign(none.style, { opacity: '0.7' });
			  return;
			}
		  
			for (const f of this.extraNotes) {
			  // chip wrapper
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
			  Object.assign(label.style, {
				overflow: 'hidden',
				textOverflow: 'ellipsis'
			  });
		  
			  // remove button (×)
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
		
			// 1. Schritt: Lese die rohen Titel/Links aus dem [!Relevant papers] Block
			// Die Funktion liefert uns z.B. ["Paper A", "Paper B"]
			const relatedTitlesRaw = await this.plugin.getRelatedPapersFromNote(currentFile);
			
			let candidates: TFile[] = [];
		
			// 2. Schritt: Umwandlung der Titel in echte Dateien
			if (relatedTitlesRaw.length > 0) {
				for (const title of relatedTitlesRaw) {
					// WICHTIG: Nutze getFirstLinkpathDest, um den Wikilink aufzulösen
					const file = this.app.metadataCache.getFirstLinkpathDest(title, currentFile.path);
					if (file instanceof TFile) {
						candidates.push(file);
					}
				}
				console.log(`[RAG] Aus Notiz geladen: ${candidates.length} Dateien.`);
			}
		
			// 3. Schritt: NUR wenn wirklich gar nichts in der Notiz stand, starte die LLM-Suche
			if (candidates.length === 0) {
				new Notice("Keine Liste in Notiz gefunden. Starte KI-Suche...");
				candidates = await this.plugin.findTopRelevantNotes(currentFile, 10);
			}
		
			// 4. Schritt: Zeige die Auswahl an (begrenzt auf 10)
			if (candidates.length === 0) {
				new Notice("Keine relevanten Arbeiten gefunden.");
				return;
			}
		
			// Modal öffnen, um die Auswahl zu bestätigen/anzupassen
			new NoteSelectorModal(this.app, candidates.slice(0, 10), (selected: TFile[]) => {
				if (selected && selected.length > 0) {
					this.extraNotes = selected; // Speichert die Auswahl in der View
					renderExtraChips();         // Zeichnet die Buttons (Chips) neu
					new Notice(`${selected.length} Arbeiten zum Chat hinzugefügt.`);
				}
			}).open();
		};							  
	  
		renderExtraChips();
	  
		// Chat history container (fills remaining height)
		this.chatContainer = root.createDiv({ cls: 'llm-chat-container' });
		Object.assign(this.chatContainer.style, {
		  flex: '1',
		  overflowY: 'auto',
		  border: '1px solid var(--background-modifier-border)',
		  background: 'var(--background-primary)',
		  borderRadius: '12px',
		  padding: '10px'
		});
	  
		// Input row pinned at bottom
		const inputRow = root.createDiv({ cls: 'llm-chat-input-row' });
		Object.assign(inputRow.style, {
		  display: 'flex',
		  gap: '8px',
		  alignItems: 'center'
		});
	  
		this.inputEl = inputRow.createEl('input', {
		  type: 'text',
		  placeholder: 'Frage stellen…'
		});
	  
		Object.assign(this.inputEl.style, {
		  width: '100%',
		  padding: '10px 12px',
		  borderRadius: '10px',
		  border: '1px solid var(--background-modifier-border)',
		  background: 'var(--background-secondary)',
		  fontSize: '13px'
		});
	  
		// Optional Send button (nice UX)
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
	  
		sendBtn.onclick = () => send();
	  
		this.renderMessages();
	}

	private renderMessages() {
		this.chatContainer.empty();
	  
		for (const m of this.messages) {
		  const isUser = m.role === 'user';
	  
		  // Row aligns left/right
		  const row = this.chatContainer.createDiv({ cls: 'llm-chat-row' });
		  Object.assign(row.style, {
			display: 'flex',
			justifyContent: isUser ? 'flex-end' : 'flex-start',
			margin: '10px 0'
		  });
	  
		  // Bubble wrapper (limits width)
		  const wrap = row.createDiv();
		  Object.assign(wrap.style, {
			maxWidth: '78%',
			display: 'flex',
			flexDirection: 'column',
			gap: '4px'
		  });
	  
		  // Small label
		  const label = wrap.createDiv({ text: isUser ? 'Du' : 'Assistent' });
		  Object.assign(label.style, {
			fontSize: '11px',
			opacity: '0.7',
			paddingLeft: isUser ? '0' : '2px',
			paddingRight: isUser ? '2px' : '0',
			textAlign: isUser ? 'right' : 'left'
		  });
	  
		  // Bubble
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
	  
		  // Make user bubble corner slightly different (chat feel)
		  if (isUser) {
			bubble.style.borderTopRightRadius = '6px';
		  } else {
			bubble.style.borderTopLeftRadius = '6px';
		  }
		}
	  
		this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
	}
	
	// Neue Hilfsfunktion: Current paper Metadaten + Summary summarisiert zurückgeben
	private async summarizeCurrentNoteFromCurrentFile(): Promise<{ metadata: any; summary: string } | null> {
		const currentFile = this.app.workspace.getActiveFile();
		if (!currentFile) return null;
	
		try {
		  const noteText = await this.app.vault.read(currentFile);
		  const currentMetadata = await this.plugin.extractCurrentNoteMetadata(noteText);
	
		  // Text extrahieren und säubern (wie im bisherigen Flow)
		  const extractedText = await this.plugin.extractPDFTextFromNote(noteText);
		  const cleanedText = await this.plugin.preCleanText(extractedText);
	
		  // Falls kein Text vorhanden ist, fallback auf leere Zusammenfassung
		  if (!cleanedText || cleanedText.trim().length === 0) {
			const fallback = await this.plugin.processWithLlama3(`Summarize this note concisely:\n\n${noteText}`);
			return { metadata: currentMetadata, summary: fallback.message.content.trim() };
		  }
	
		  // Chunking wie bisher
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
	
			const resp = await this.plugin.processWithLlama3(`${prefix}${metaNote}\n\n${chunk}`);
			chunkSummaries.push(resp.message.content.trim());
		  }
	
		  const consolidatePrompt = `You are given several partial summaries from chunks of an academic paper. Combine them into one concise, cohesive summary paragraph.
	
	--- PARTIAL SUMMARIES ---
	${chunkSummaries.map((s, idx) => `Summary ${idx + 1}: ${s}`).join('\n\n')}
	--- END ---`;
	
		  const finalSummaryResponse = await this.plugin.processWithLlama3(consolidatePrompt);
		  const finalSummary = finalSummaryResponse.message.content.trim();
	
		  return { metadata: currentMetadata, summary: finalSummary };
		} catch (e) {
		  console.error("Error summarizing current note:", e);
		  return null;
		}
	}
	
	// --- Helper: Paper-Packs (metadata + summary) für mehrere Files bauen ---
	private async collectPaperPacks(files: TFile[]): Promise<ExtraSummary[]> {
		const packs: ExtraSummary[] = [];
	
		for (const f of files) {
		try {
			const text = await this.app.vault.read(f);
			const metadata = await this.plugin.extractCurrentNoteMetadata(text);
	
			// 1) bevorzugt vorhandene Summary aus Note verwenden
			let summary = this.plugin.extractSummaryFromNoteText(text);
	
			// ✅ Kein LLM-Fallback: wenn keine Summary, dann leer lassen
			if (!summary) summary = "";
	
			packs.push({
				id: f.path,
				title: f.basename,
				metadata,
				summary
			});			  
		} catch (e) {
			console.warn("collectPaperPacks failed for", f.path, e);
			packs.push({ id: f.path, title: f.basename, metadata: {}, summary: "" });
		}
		}
	
		return packs;
	}
	
	// --- Helper: Prompt für Multi-Paper-QA (pro Paper antworten, KEIN Chunk-RAG) ---
	private buildMultiPaperPrompt(userQuestion: string, papers: ExtraSummary[]): string {
		const paperBlock = papers.map((p, i) => {
		  const md = p.metadata ?? {};
	  
		  const raw = md.authors ?? md.author; // ✅ author oder authors
		  const wikiAuthorsArr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
		  const wikiAuthors = wikiAuthorsArr.map(a => String(a).trim()).filter(Boolean);
	  
		  const normAuthors = wikiAuthors.map(a => this.wikiToPlain(a)).filter(Boolean);
	  
		  const title = md.title ?? `[[${p.title}]]`; // ✅ Wikilink fallback
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
		
			// Build scope (wie bisher)
			let scopeFiles: TFile[] = [currentFile, ...this.extraNotes];
		
			const seen = new Set<string>();
			scopeFiles = scopeFiles.filter(f => (seen.has(f.path) ? false : (seen.add(f.path), true)));
		
			if (this.extraNotes.length > 0) {
				// 1) Extras zusammenfassen
				const extrasSummaries = await this.summarizeExtras();

				// 2) Current zusammenfassen
				const currentPaper = await this.summarizeCurrentNoteFromCurrentFile();

				// 3) Current zuerst, dann Extras
				const papers: ExtraSummary[] = [];

				if (currentPaper) {
					papers.push({
					  id: "CURRENT",
					  title: currentFile.basename,
					  metadata: currentPaper.metadata ?? {},
					  summary: currentPaper.summary ?? ""
					});
				}

				// Extras danach (kurze IDs)
				extrasSummaries.forEach((p, idx) => {
					papers.push({
					...p,
					id: `EXTRA_${idx + 1}`
					});
				});
			  
				// 4) EIN Prompt, EIN Request
				const finalPrompt = this.buildMultiPaperPrompt(text, papers);
				console.log("[MultiPaper] Order:", papers.map(p => p.id + " | " + p.title));
				console.log("[MultiPaper] Prompt preview:", finalPrompt.slice(0, 1200));
				for await (const chunk of this.plugin.processWithLlama3Stream(finalPrompt)) {
				assistantMsg.content += chunk;
				this.renderMessages();
				}

				await this.plugin.saveChatToNote(this.messages);
				return;
			}					
	  
		// =========================================================
		// FALL A: Standard (aktuelles Paper / Ordner) -> RAG bleibt
		// =========================================================
	  
		  const retrieved = await this.plugin.retrieveRelevantChunks(text, scopeFiles, this.plugin.settings.topK);
	  
		  if (retrieved.length === 0) {
			assistantMsg.content = "Ich habe keine indexierten Inhalte gefunden (oder der Kontext ist leer). Bitte indexiere zuerst die Notizen oder prüfe den PDF-Text Abschnitt.";
			this.renderMessages();
			return;
		  }
	  
		  const finalPrompt = this.plugin.buildRagPrompt(text, retrieved);
		  console.groupCollapsed("[RAG] Final prompt");
		  console.log("Length:", finalPrompt.length);
		  console.log("Retrieved:", retrieved.map(r => `${r.fileName}#${r.chunkIndex}`));
		  console.log("Prompt preview:", finalPrompt.slice(0, 2000) + (finalPrompt.length > 2000 ? "…(truncated)" : ""));
		  console.groupEnd();
	  
		  console.log("[RAG] Retrieved chunks:", retrieved.map(r => `${r.fileName}#${r.chunkIndex}`));
		  console.log("[RAG] Prompt length:", finalPrompt.length);
	  
		  for await (const chunk of this.plugin.processWithLlama3Stream(finalPrompt)) {
			assistantMsg.content += chunk;
			this.renderMessages();
		  }
		} catch (e) {
		  assistantMsg.content += `\n\n[Error: ${e}]`;
		  this.renderMessages();
		}
	  
		await this.plugin.saveChatToNote(this.messages);
	}	  

	async onClose() {
		this.containerEl.empty();
	}
}

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
  
	  // Optional: select all toggle
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

class DragAndDropModal extends Modal {
	result: string;
	constructor(app: App, result: string) {
		super(app);
		this.result = result;
	}

	updateContent(newContent: string) {
		this.result = newContent;
		this.contentEl.empty();
		this.onOpen();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Please wait a moment' });
		const resultEl = contentEl.createDiv();
		resultEl.innerHTML = this.result.replace(/\n/g, "<br>");
		resultEl.style.maxHeight = '200px';
		resultEl.style.overflowY = 'auto';
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ========= PDF extraction helpers (TOP-LEVEL, not inside the class) =========
type TextItemLike = {
	str: string;
	transform: number[];   // [a,b,c,d,e,f]
	width?: number;
	height?: number;
	fontName?: string;
  };
  
  type Positioned = {
	str: string;
	x: number;
	y: number;
	w: number;
	h: number;
  };
  
  function norm(s: string) {
	return s.replace(/\s+/g, " ").trim();
  }
  
  /* function isMostlyNoise(s: string) {
	const t = norm(s);
	if (!t) return true;
	if (/^\d{1,4}$/.test(t)) return true;
	if (/^(arxiv|doi)\b/i.test(t)) return true;
	return false;
  }  */ 

export default class BachelorSaidPlugin extends Plugin {
	settings: MyPluginSettings;

	private ragIndex: RagIndex | null = null;
  	private ragIndexPath: string | null = null;

	private logPreview(label: string, text: string, max = 400) {
		const t = (text ?? "").toString();
		const preview = t.length > max ? t.slice(0, max) + "…(truncated)" : t;
		console.log(label, preview);
	}
	  
	private nowMs() {
		return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
	}	  

	// --- Helper: Summary aus Note lesen (## Summary) ---
	extractSummaryFromNoteText(noteText: string): string {
		const m = noteText.match(/##\s*Summary\s*\n([\s\S]*?)(?:\n##|$)/i);
		return m ? m[1].trim() : "";
	}

	async getRelatedPapersFromNote(noteFile: TFile): Promise<string[]> {
		const text = await this.app.vault.read(noteFile);
		const blockMatch = text.match(/^\s*>\s*\[!Relevant papers\][\s\S]*?(?=\n(?!\s*>)[^\n]|\s*$)/im);
		if (!blockMatch) return [];
	
		const block = blockMatch[0];
		// Sucht alle [[ ... ]]
		const links = Array.from(block.matchAll(/\[\[([^\]]+)\]\]/g)).map(m => {
			const fullLink = m[1];
			// Falls Alias benutzt wird: [[Datei|Anzeigename]] -> wir brauchen "Datei"
			return fullLink.split('|')[0].trim();
		});
	
		return links;
	}  

	async findTopRelevantNotes(currentFile: TFile, limit = 10): Promise<TFile[]> {
		const currentNoteText = await this.app.vault.read(currentFile);
		const summaryMatch = currentNoteText.match(/##\s*Summary\s*\n([\s\S]*?)(?:\n##|$)/i);
		
		if (!summaryMatch) {
			new Notice("No summary found in current note.");
			return [];
		}
	
		const currentSummary = summaryMatch[1].trim();
		const allFiles = this.app.vault.getMarkdownFiles(); // ✅ Einmal am Anfang definieren
		const otherSummaries: { file: TFile; title: string; summary: string }[] = [];
	
		for (const file of allFiles) {
			if (file.path === currentFile.path) continue;
	
			const text = await this.app.vault.read(file);
			const sm = text.match(/##\s*Summary\s*\n([\s\S]*?)(?:\n##|$)/i);
			if (!sm) continue;
	
			otherSummaries.push({
				file,
				title: file.basename,
				summary: sm[1].trim()
			});
		}
	
		if (otherSummaries.length === 0) {
			new Notice("No other notes with summaries found.");
			return [];
		}
	
		const loadingModal = new DragAndDropModal(this.app, "Looking for relevant papers...");
		loadingModal.open();
	
		// ✅ Variable umbenannt zu llmPrompt (verhindert Konflikt mit window.prompt)
		const llmPrompt = `
		  You are given one academic paper summary and a list of other paper summaries.
		  Identify which other summaries are relevant to the main one.
		  Return ONLY the titles of the relevant ones, each on a new line. No explanation.
		  Return at most ${limit} titles.
		  
		  Main Summary:
		  ${currentSummary}
		  
		  Other Summaries:
		  ${otherSummaries.map(s => `Title: ${s.title}\nSummary: ${s.summary}`).join('\n\n')}
		`;
	
		try {
			const response = await this.processWithLlama3(llmPrompt);
			const content = response.message.content;
	
			// 1. Bereinige die Zeilen
			const relevantTitles = content
				.split('\n')
				.map(line => line.replace(/^[\d\s\-\.\*]+/, '').replace(/["']/g, '').trim())
				.filter(Boolean);
	
			console.log("[RAG] Llama suggested titles:", relevantTitles);
	
			const matchedFiles: TFile[] = [];
	
			for (const title of relevantTitles) {
				// Suche über MetadataCache
				const file = this.app.metadataCache.getFirstLinkpathDest(title, currentFile.path);
				if (file instanceof TFile) {
					matchedFiles.push(file);
				} else {
					// Zweiter Versuch: Fuzzy Match im bereits existierenden allFiles Array
					const fuzzyMatch = allFiles.find(f => 
						title.toLowerCase().includes(f.basename.toLowerCase()) ||
						f.basename.toLowerCase().includes(title.toLowerCase())
					);
					if (fuzzyMatch) matchedFiles.push(fuzzyMatch);
				}
			}
	
			loadingModal.close(); // ✅ Modal schließen nach Erfolg
			
			// Dubletten entfernen und Limit einhalten
			return [...new Set(matchedFiles)].slice(0, limit);
	
		} catch (error) {
			console.error("Llama search failed:", error);
			loadingModal.close(); // ✅ Modal auch im Fehlerfall schließen
			new Notice("Error during relevant paper search.");
			return [];
		}
	}	  

	async onload() {
		await this.loadSettings();

		const cfg = (this.app.vault as any).configDir ?? ".obsidian";
		this.ragIndexPath = `${cfg}/plugins/${this.manifest.id}/rag-index.json`;

		console.log("[RAG] manifest.id =", this.manifest.id);
		console.log("[RAG] ragIndexPath =", this.ragIndexPath);
		new Notice("RAG path: " + this.ragIndexPath);

		await this.loadRagIndex();

		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

		this.addRibbonIcon('message-square', 'Open LLaMA3 Chat (sidebar)', async () => {
			await this.openChatView();
		  });

		this.registerDomEvent(document, 'drop', async (evt: DragEvent) => {
			if (!evt.dataTransfer) return;
			const files = Array.from(evt.dataTransfer.files).filter(
				(f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith('.pdf')
			);
			if (files.length > 0) {
				evt.preventDefault();
				new Notice("Processing dropped PDF file(s)...");
				for (const file of files) {
					await this.handleDroppedPDF(file);
				}
			}
		});
		
		this.registerDomEvent(document, 'dragover', (evt: DragEvent) => {
			evt.preventDefault();
		});

		this.registerMarkdownPostProcessor((el, ctx) => {
			const buttons = el.querySelectorAll(".relevance-button");
			buttons.forEach(button => {
				button.addEventListener("click", async () => {
					const file = ctx.sourcePath ? this.app.vault.getAbstractFileByPath(ctx.sourcePath) as TFile : null;
					if (file) await this.runRelevanceAnalysis(file);
				});
			});
		});		
	}

	private async loadRagIndex() {
		console.log("[RAG][LOAD] reading:", this.ragIndexPath);
		const empty: RagIndex = { version: 1, embeddingModel: this.settings.embeddingModel, chunks: [] };
	
		try {
		  if (!this.ragIndexPath) { this.ragIndex = empty; return; }
	
		  const exists = await this.app.vault.adapter.exists(this.ragIndexPath);
		  if (!exists) {
			this.ragIndex = empty;
			await this.saveRagIndex();
			return;
		  }
		  const raw = await this.app.vault.adapter.read(this.ragIndexPath);
		  const parsed = JSON.parse(raw) as RagIndex;
	
		  // if embedding model changed, you can keep chunks but results might degrade
		  // simplest: keep, but note mismatch
		  this.ragIndex = parsed;
		} catch (e) {
		  console.warn("Failed to load rag index, recreating:", e);
		  this.ragIndex = empty;
		  await this.saveRagIndex();
		}
	}
	
	private async saveRagIndex() {
		console.log("[RAG][SAVE] writing:", this.ragIndexPath, "chunks:", this.ragIndex?.chunks?.length);
		if (!this.ragIndexPath || !this.ragIndex) return;
		console.log("[RAG][SAVE] path=", this.ragIndexPath, "chunks=", this.ragIndex?.chunks?.length);
	
		try {
		  const folder = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		  const folderExists = await this.app.vault.adapter.exists(folder);
		  if (!folderExists) await this.app.vault.adapter.mkdir(folder);
	
		  await this.app.vault.adapter.write(this.ragIndexPath, JSON.stringify(this.ragIndex));
		} catch (e) {
		  console.error("Failed to save rag index:", e);
		}
	}

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
	  
		// Sehr kurze Zeilen ignorieren
		if (t.length < 3) return null;
	  
		// Paper-typische Headings (robust)
		const known = [
		  "abstract", "introduction", "background", "related work", "method",
		  "methods", "methodology", "approach", "experiments", "results",
		  "discussion", "conclusion", "conclusions", "references", "bibliography",
		  "appendix", "acknowledgements", "limitations"
		];
	  
		const lower = t.toLowerCase();
	  
		// 1) Exact / simple match (Abstract)
		if (known.includes(lower)) return t;
	  
		// 2) Numbered headings: "1 Introduction", "2.3 Experiments"
		if (/^\d+(\.\d+)*\s+[A-Za-z].{2,80}$/.test(t)) return t;
	  
		// 3) ALL CAPS headings (common in PDFs)
		if (/^[A-Z][A-Z0-9\s\-:]{3,80}$/.test(t) && t.split(" ").length <= 10) return t;
	  
		return null;
	  }
	  
	  private packParagraphsIntoChunks(paragraphs: string[], chunkSize: number, overlap: number): string[] {
		const chunks: string[] = [];
		let cur = "";
	  
		const pushCur = () => {
		  const x = cur.trim();
		  if (x) chunks.push(x);
		  cur = "";
		};
	  
		for (const p of paragraphs) {
		  const para = (p ?? "").trim();
		  if (!para) continue;
	  
		  // Falls einzelner Absatz größer als chunkSize: hart splitten (Fallback)
		  if (para.length > chunkSize) {
			if (cur.trim()) pushCur();
			for (let i = 0; i < para.length; i += chunkSize) {
			  chunks.push(para.slice(i, i + chunkSize));
			}
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
	  
		// overlap durch “rollenden” Text: wir hängen tail vom vorherigen Chunk vorne an
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
	  
		type Sec = { title: string; paras: string[] };
		const sections: Sec[] = [];
	  
		let currentTitle = "Preamble";
		let currentParas: string[] = [];
		let curPara = "";
	  
		const flushPara = () => {
		  const p = curPara.trim();
		  if (p) currentParas.push(p);
		  curPara = "";
		};
	  
		const flushSection = () => {
		  flushPara();
		  if (currentParas.length) sections.push({ title: currentTitle, paras: currentParas });
		  currentParas = [];
		};
	  
		for (const line of lines) {
		  const h = this.detectHeading(line);
	  
		  // Überschrift nur als Überschrift zählen, wenn Absatz gerade “leer” ist (sonst mitten im Satz)
		  if (h && curPara.trim().length === 0) {
			flushSection();
			currentTitle = h;
			continue;
		  }
	  
		  // Absatztrennung: leere Zeile
		  if (!line.trim()) {
			flushPara();
			continue;
		  }
	  
		  // normaler Text
		  curPara += (curPara ? " " : "") + line.trim();
		}
	  
		flushSection();
	  
		// Jetzt packen wir pro Section in chunks
		return sections.map(sec => ({
		  section: sec.title,
		  chunks: this.packParagraphsIntoChunks(sec.paras, chunkSize, overlap),
		}));
	}	  
	
	private async sha256(input: string): Promise<string> {
		// WebCrypto works in Obsidian (Electron)
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

	private mmrSelect(
		scored: {chunk: VectorChunk; score: number}[],
		k: number,
		lambda = 0.75
	  ) {
		const selected: {chunk: VectorChunk; score: number}[] = [];
		const remaining = [...scored];
	  
		while (selected.length < k && remaining.length) {
		  let bestIdx = 0;
		  let bestVal = -Infinity;
	  
		  for (let i = 0; i < remaining.length; i++) {
			const cand = remaining[i];
	  
			// diversity: max similarity to already selected
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
	  
	private async getSummaryEmbedding(file: TFile): Promise<{ file: TFile; summary: string; vec: number[] } | null> {
		const text = await this.app.vault.read(file);
		const summary = this.extractSummaryFromNoteText(text);
		if (!summary) return null;
	  
		// Optional: Summary kürzen, damit Embedding stabil und schnell bleibt
		const trimmed = summary.length > 2500 ? summary.slice(0, 2500) : summary;
		const vec = await this.embedText(trimmed);
		return { file, summary: trimmed, vec };
	}
	  
	async findRelatedPapersBySummarySimilarity(
		currentFile: TFile,
		limit = 10,
		minScore = 0.78
	  ): Promise<{ file: TFile; score: number }[]> {
	  
		const current = await this.getSummaryEmbedding(currentFile);
		if (!current) {
		  new Notice("Current note has no Summary section.");
		  return [];
		}
	  
		const allFiles = this.app.vault.getMarkdownFiles()
		  .filter(f => f.path !== currentFile.path);
	  
		const candidates: { file: TFile; score: number }[] = [];
	  
		// optional: nur Notes mit Summary
		for (const f of allFiles) {
		  try {
			const other = await this.getSummaryEmbedding(f);
			if (!other) continue;
	  
			const score = this.cosineSimilarity(current.vec, other.vec);
			if (score >= minScore) {
			  candidates.push({ file: f, score });
			}
		  } catch (e) {
			console.warn("Similarity check failed for", f.path, e);
		  }
		}
	  
		candidates.sort((a, b) => b.score - a.score);
		return candidates.slice(0, limit);
	}
	
	async findAndSaveRelatedPapers(currentFile: TFile, limit = 10): Promise<TFile[]> {
		const relatedResults = await this.findRelatedPapersBySummarySimilarity(currentFile, limit);
		const relatedFiles = relatedResults.map(r => r.file);

		if (relatedFiles.length === 0) {
			new Notice("No relevant papers found.");
			return [];
		}

		await this.updateRelevantPapersBlock(currentFile, relatedFiles);
		return relatedFiles;
	}

	private async updateRelevantPapersBlock(file: TFile, related: TFile[]) {
		const text = await this.app.vault.read(file);
		// Erstellt die Liste als schön formatierte Callout-Liste
		const linksText = related.map(f => `> - [[${f.basename}]]`).join('\n');
		const newBlock = `> [!Relevant papers]\n${linksText}`;

		const blockRegex = /^\s*>\s*\[!Relevant papers\][\s\S]*?(?=\n(?!\s*>)[^\n]|\s*$)/im;
		
		let updatedText;
		if (blockRegex.test(text)) {
			updatedText = text.replace(blockRegex, newBlock);
		} else {
			// Fügt es nach der Summary oder am Anfang ein
			updatedText = text.includes("## Summary") 
				? text.replace("## Summary", `## Summary\n\n${newBlock}\n`)
				: newBlock + "\n\n" + text;
		}
		
		await this.app.vault.modify(file, updatedText);
		new Notice("Relevant papers updated in note.");
	}
	
	
	/* async embedText(text: string): Promise<number[]> {
		const url = "http://153.96.23.232/ollama/api/embeddings";
		const payload = { model: this.settings.embeddingModel, prompt: text };
	  
		const t0 = this.nowMs();
		console.groupCollapsed(`[RAG][EMBED] ${this.settings.embeddingModel}`);
		this.logPreview("Prompt:", text, 300);
	  
		const res = await fetch(url, {
		  method: "POST",
		  headers: { "Content-Type": "application/json" },
		  body: JSON.stringify(payload)
		});
	  
		console.log("Status:", res.status);
	  
		if (!res.ok) {
		  console.groupEnd();
		  throw new Error(`Embeddings API returned ${res.status}`);
		}
	  
		const data = await res.json();
		const t1 = this.nowMs();
	  
		if (!data?.embedding || !Array.isArray(data.embedding)) {
		  console.groupEnd();
		  throw new Error("Embeddings response missing embedding[]");
		}
	  
		console.log("Embedding length:", data.embedding.length);
		console.log("Time ms:", Math.round(t1 - t0));
		console.groupEnd();
	  
		return data.embedding as number[];
	} */
	
	async embedText(text: string): Promise<number[]> {
		const url = "https://api.openai.com/v1/embeddings";
		const openaiApiKey = this.settings.openaiApiKey;
		const model = "text-embedding-3-small";
	  
		const payload = {
		  model,
		  input: text
		};
	  
		const t0 = this.nowMs();
		console.groupCollapsed(`[RAG][EMBED][OpenAI] ${model}`);
		this.logPreview("Input:", text, 300);
	  
		const res = await fetch(url, {
		  method: "POST",
		  headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${openaiApiKey}`
		  },
		  body: JSON.stringify(payload)
		});
	  
		console.log("Status:", res.status);
	  
		if (!res.ok) {
		  const errText = await res.text().catch(() => "");
		  console.log("Error body:", errText);
		  console.groupEnd();
		  throw new Error(`OpenAI Embeddings API returned ${res.status}`);
		}
	  
		const data = await res.json();
		const t1 = this.nowMs();
	  
		const embedding = data?.data?.[0]?.embedding;
		if (!embedding || !Array.isArray(embedding)) {
		  console.groupEnd();
		  throw new Error("Embeddings response missing data[0].embedding[]");
		}
	  
		console.log("Embedding length:", embedding.length);
		console.log("Time ms:", Math.round(t1 - t0));
		console.groupEnd();
	  
		return embedding as number[];
	}	  

	private ensureRagIndex(): RagIndex {
		if (!this.ragIndex) {
		  this.ragIndex = { version: 1, embeddingModel: this.settings.embeddingModel, chunks: [] };
		}
		return this.ragIndex;
	}
	
	async indexNoteFile(file: TFile): Promise<void> {
		const idx = this.ensureRagIndex();
		const noteText = await this.app.vault.read(file);
	  
		const extracted = await this.extractPDFTextFromNote(noteText);
		const contentToIndex = (extracted && extracted.length > 0) ? extracted : noteText;
		const cleaned = await this.preCleanText(contentToIndex);
	  
		const mtime = file.stat.mtime;
	  
		// alte chunks entfernen
		idx.chunks = idx.chunks.filter(c => c.filePath !== file.path);
	  
		// ✅ (C) Metadata chunk
		const md = await this.extractCurrentNoteMetadata(noteText);
		const metaTextRaw = this.buildMetadataChunkText(file, md);
		const metaText = this.cleanWikiLinks(metaTextRaw);
		if (metaText.trim()) {
		  const hash = await this.sha256("META::" + metaText);
		  const id = `${file.path}::META::${hash.slice(0, 12)}`;
		  const embedding = await this.embedText(metaText);
	  
		  idx.chunks.push({
			id,
			filePath: file.path,
			fileName: file.basename,
			chunkIndex: -2,
			chunkType: "meta",
			section: "Metadata",
			text: metaText,
			embedding,
			hash,
			mtime,
			updatedAt: new Date().toISOString()
		  });
		}
	  
		// ✅ lead chunk (Intro/Abstract-Anker)
		const lead = cleaned.slice(0, 6000);
		if (lead.trim()) {
		  const hash = await this.sha256("LEAD::" + lead);
		  const id = `${file.path}::LEAD::${hash.slice(0, 12)}`;
		  const embedding = await this.embedText(lead);
	  
		  idx.chunks.push({
			id,
			filePath: file.path,
			fileName: file.basename,
			chunkIndex: -1,
			chunkType: "lead",
			section: "Lead",
			text: lead,
			embedding,
			hash,
			mtime,
			updatedAt: new Date().toISOString()
		  });
		}
	  
		// ✅ (A) Section-aware chunking (Fallback auf chunkText wenn nichts erkannt wird)
		const sectioned = this.chunkTextBySections(cleaned, this.settings.chunkSize, this.settings.chunkOverlap);
	  
		let bodyIndex = 0;
		const allBodyChunks: { section: string; text: string }[] = [];
	  
		for (const sec of sectioned) {
		  for (const ch of sec.chunks) {
			const t = (ch ?? "").trim();
			if (!t) continue;
			allBodyChunks.push({ section: sec.section, text: t });
		  }
		}
	  
		// Fallback: falls section parser kaum was geliefert hat
		if (allBodyChunks.length === 0) {
		  const fallbackChunks = this.chunkText(cleaned, this.settings.chunkSize, this.settings.chunkOverlap);
		  for (const ch of fallbackChunks) {
			const t = ch.trim();
			if (t) allBodyChunks.push({ section: "Body", text: t });
		  }
		}
	  
		for (const item of allBodyChunks) {
		  const text = item.text;
		  const hash = await this.sha256(text);
		  const id = `${file.path}::${bodyIndex}::${hash.slice(0, 12)}`;
		  const embedding = await this.embedText(text);
	  
		  idx.chunks.push({
			id,
			filePath: file.path,
			fileName: file.basename,
			chunkIndex: bodyIndex,
			chunkType: "section",
			section: item.section,
			text,
			embedding,
			hash,
			mtime,
			updatedAt: new Date().toISOString()
		  });
	  
		  bodyIndex++;
		}
	  
		idx.embeddingModel = this.settings.embeddingModel;
		console.log(`[RAG][INDEX] ${file.basename}: meta+lead+${bodyIndex} chunks`);
		await this.saveRagIndex();
	}	  

	async retrieveRelevantChunks(query: string, scopeFiles: TFile[], topK: number): Promise<VectorChunk[]> {
		const idx = this.ensureRagIndex();
	  
		console.groupCollapsed(`[RAG][RETRIEVE] topK=${topK}`);
		this.logPreview("Query:", query, 250);
		console.log("Scope files:", scopeFiles.map(f => f.basename));
	  
		// Lazy indexing
		for (const f of scopeFiles) {
			const fileChunks = idx.chunks.filter(c => c.filePath === f.path);
			const hasAny = fileChunks.length > 0;
		  
			const newestIndexedMtime = fileChunks.reduce((mx, c) => Math.max(mx, c.mtime ?? 0), 0);
			const fileMtime = f.stat.mtime;
		  
			const needsReindex = !hasAny || fileMtime > newestIndexedMtime;
		  
			if (needsReindex) {
			  console.log(`[RAG][RETRIEVE] Reindex needed: ${f.basename} (fileMtime=${fileMtime}, indexed=${newestIndexedMtime})`);
			  try {
				await this.indexNoteFile(f);
			  } catch (e) {
				console.warn("[RAG][RETRIEVE] Indexing failed for", f.path, e);
			  }
			}
		}		  
	  
		const scopePaths = new Set(scopeFiles.map(f => f.path));
		const candidates = idx.chunks.filter(c => scopePaths.has(c.filePath));
		if (!candidates.length) return [];

		const qVec = await this.embedText(query);
		const scored = candidates.map(c => ({ chunk: c, score: this.cosineSimilarity(qVec, c.embedding) }));
		scored.sort((a, b) => b.score - a.score);

		const top = this.mmrSelect(scored, topK, 0.8);

		// ✅ NEU: neighbor expansion
		const byFile = new Map<string, VectorChunk[]>();
		for (const c of candidates) {
			if (!byFile.has(c.filePath)) byFile.set(c.filePath, []);
			byFile.get(c.filePath)!.push(c);
		}
		for (const arr of byFile.values()) arr.sort((a,b)=>a.chunkIndex-b.chunkIndex);

		const expanded: VectorChunk[] = [];
		const seen = new Set<string>();

		const push = (c: VectorChunk) => {
			if (seen.has(c.id)) return;
			seen.add(c.id);
			expanded.push(c);
		};

		for (const hit of top) {
			const c = hit.chunk;
			push(c);

			const arr = byFile.get(c.filePath)!;
			const i = arr.findIndex(x => x.id === c.id);
			if (i >= 0) {
			if (arr[i - 1]) push(arr[i - 1]); // prev
			if (arr[i + 1]) push(arr[i + 1]); // next
			}
		}

		// optional: sort by (file, chunkIndex) damit es lesbar ist
		expanded.sort((a,b)=> (a.filePath.localeCompare(b.filePath)) || (a.chunkIndex - b.chunkIndex));
		// ✅ Always include meta chunk per file (if present), to make author/year/venue reliably answerable
		for (const f of scopeFiles) {
			const meta = idx.chunks.find(c => c.filePath === f.path && c.chunkType === "meta");
			if (meta) {
			if (!expanded.some(x => x.id === meta.id)) expanded.unshift(meta);
			}
		}  
		return expanded;
	}

	private buildMetadataChunkText(file: TFile, metadata: any): string {
		const clean = (val: any) => {
			if (Array.isArray(val)) return val.map(v => this.cleanWikiLinks(String(v))).join(", ");
			return this.cleanWikiLinks(String(val ?? "N/A"));
		};
	
		return [
		  "=== METADATA ===",
		  `Title: ${clean(metadata?.title ?? file.basename)}`,
		  `Authors: ${clean(metadata?.authors ?? metadata?.author)}`,
		  `Venue: ${clean(metadata?.conference ?? metadata?.journal)}`,
		  `Keywords: ${clean(metadata?.keywords)}`,
		  `Year: ${clean(metadata?.year)}`,
		].join("\n");
	}	  

	buildRagPrompt(userQuestion: string, retrieved: VectorChunk[]): string {
		// Falls ein Meta-Chunk dabei ist, stellen wir sicher, dass er ganz oben steht 
		// und das Modell nicht durch 12.000 Zeichen Rauschen abgelenkt wird.
		const isMetaQuery = /author|title|who wrote|venue|published/i.test(userQuestion);
		
		// Bei Meta-Anfragen reduzieren wir die maximale Länge massiv, 
		// damit die Aufmerksamkeit des LLM voll auf den ersten Chunks liegt.
		const MAX_TOTAL = isMetaQuery ? 4000 : 12000; 
		
		let used = 0;
		const blocks: string[] = [];
		
		// Sortiere retrieved so, dass 'meta' immer an Index 0 ist (falls nicht schon geschehen)
		const sorted = [...retrieved].sort((a, b) => {
			if (a.chunkType === "meta") return -1;
			if (b.chunkType === "meta") return 1;
			return 0;
		});
	
		for (let i = 0; i < sorted.length; i++) {
			const c = sorted[i];
			const header = `[#${i + 1}] SOURCE TYPE: ${(c.chunkType ?? "body").toUpperCase()}\n`;			const remain = MAX_TOTAL - used - header.length;
			if (remain <= 200) break;
	
			const snippet = c.text.length > remain ? c.text.slice(0, remain) + "..." : c.text;
			blocks.push(header + snippet);
			used += header.length + snippet.length;
		}
	
		return `You are a precise academic record keeper.
		
	### CRITICAL RULE:
	The block marked "SOURCE TYPE: META" contains the definitive bibliographic data.
	If the user asks for authors, you MUST list the names found in the META block.
	
	--- CONTEXT ---
	${blocks.join("\n\n")}
	--- END CONTEXT ---
	
	Question: ${userQuestion}
	Final Answer:`;
	}
	
	private cleanWikiLinks(text: string): string {
		if (!text) return "";
		// Entfernt [[ und ]] - behält aber den Text dazwischen
		return text.replace(/\[\[/g, "").replace(/\]\]/g, "");
	}

	async openChatView() {
		// can be undefined if no such view exists
		let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
	  
		if (!leaf) {
		  // this may return null, so declare leaf as WorkspaceLeaf | null
		  const rightLeaf = this.app.workspace.getRightLeaf(true);
		  if (rightLeaf) {
			await rightLeaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
			leaf = rightLeaf;
		  }
		}
	  
		if (leaf) {
		  this.app.workspace.revealLeaf(leaf);
		} else {
		  console.error("Could not open chat view: no right leaf available.");
		}
	}
	  
	// (C) streaming helper; works with Ollama's `stream: true`
	/* async *processWithLlama3Stream(text: string): AsyncGenerator<string> {
		const url = "http://153.96.23.232/ollama/api/chat";
		const payload = {
		  model: "llama3:8b",
		  messages: [{ role: "user", content: text }],
		  stream: true
		};
	  
		console.groupCollapsed("[LLaMA3][STREAM] Request");
		console.log("POST", url);
		console.log("Payload:", {
		  ...payload,
		  // nur kurz anzeigen, sonst ist console unübersichtlich
		  messages: [{ role: "user", content: text.slice(0, 2000) + (text.length > 2000 ? "…(truncated)" : "") }]
		});
		console.groupEnd();
	  
		const res = await fetch(url, {
		  method: "POST",
		  headers: { "Content-Type": "application/json" },
		  body: JSON.stringify(payload)
		});
	  
		console.log("[LLaMA3][STREAM] Status:", res.status);
	  
		if (!res.ok || !res.body) throw new Error(`API returned ${res.status}`);
	  
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		let assembled = "";
	  
		while (true) {
		  const { value, done } = await reader.read();
		  if (done) break;
	  
		  buf += decoder.decode(value, { stream: true });
	  
		  let idx;
		  while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (!line) continue;
	  
			try {
			  const obj = JSON.parse(line);
	  
			  // optional: komplette raw events anzeigen (kann spam sein)
			  // console.debug("[LLaMA3][STREAM] Event:", obj);
	  
			  const piece = obj?.message?.content ?? "";
			  if (piece) {
				assembled += piece;
				console.debug("[LLaMA3][STREAM] Chunk:", piece);
				yield piece;
			  }
	  
			  if (obj?.done) {
				console.groupCollapsed("[LLaMA3][STREAM] Done");
				console.log("Final length:", assembled.length);
				console.log("Final preview:", assembled.slice(0, 2000) + (assembled.length > 2000 ? "…(truncated)" : ""));
				console.groupEnd();
				return;
			  }
			} catch (e) {
			  // ignore partial JSON lines
			}
		  }
		}
	  
		// falls stream endet ohne done=true
		console.groupCollapsed("[LLaMA3][STREAM] Ended without done");
		console.log("Final length:", assembled.length);
		console.log("Final preview:", assembled.slice(0, 2000) + (assembled.length > 2000 ? "…(truncated)" : ""));
		console.groupEnd();
	} */
	
	async *processWithLlama3Stream(text: string): AsyncGenerator<string> {
		const url = "https://api.groq.com/openai/v1/chat/completions";
		const groqApiKey = this.settings.groqApiKey;
		const model = "llama-3.1-8b-instant";
	  
		const payload = {
		  model,
		  messages: [{ role: "user", content: text }],
		  stream: true
		};
	  
		console.groupCollapsed("[Groq][STREAM] Request");
		console.log("POST", url);
		console.log("Payload:", {
		  ...payload,
		  messages: [{ role: "user", content: text.slice(0, 2000) + (text.length > 2000 ? "…(truncated)" : "") }]
		});
		console.groupEnd();
	  
		const res = await fetch(url, {
		  method: "POST",
		  headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${groqApiKey}`
		  },
		  body: JSON.stringify(payload)
		});
	  
		console.log("[Groq][STREAM] Status:", res.status);
		if (!res.ok || !res.body) {
		  const errText = await res.text().catch(() => "");
		  console.log("[Groq][STREAM] Error body:", errText);
		  throw new Error(`Groq API returned ${res.status}`);
		}
	  
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
	  
		let buf = "";
		let assembled = "";
	  
		while (true) {
		  const { value, done } = await reader.read();
		  if (done) break;
	  
		  buf += decoder.decode(value, { stream: true });
	  
		  // SSE: events are separated by "\n"
		  let idx: number;
		  while ((idx = buf.indexOf("\n")) >= 0) {
			const rawLine = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
	  
			const line = rawLine.trim();
			if (!line) continue;
	  
			// OpenAI-style SSE lines: "data: {...}" or "data: [DONE]"
			if (!line.startsWith("data:")) continue;
	  
			const dataStr = line.slice("data:".length).trim();
			if (dataStr === "[DONE]") {
			  console.groupCollapsed("[Groq][STREAM] Done");
			  console.log("Final length:", assembled.length);
			  console.log("Final preview:", assembled.slice(0, 2000) + (assembled.length > 2000 ? "…(truncated)" : ""));
			  console.groupEnd();
			  return;
			}
	  
			try {
			  const obj = JSON.parse(dataStr);
	  
			  // OpenAI-compatible delta:
			  const piece =
				obj?.choices?.[0]?.delta?.content ??
				obj?.choices?.[0]?.message?.content ?? // fallback (falls nicht-delta)
				"";
	  
			  if (piece) {
				assembled += piece;
				console.debug("[Groq][STREAM] Chunk:", piece);
				yield piece;
			  }
			} catch {
			  // ignore partial JSON lines
			}
		  }
		}
	  
		// falls stream endet ohne [DONE]
		console.groupCollapsed("[Groq][STREAM] Ended without [DONE]");
		console.log("Final length:", assembled.length);
		console.log("Final preview:", assembled.slice(0, 2000) + (assembled.length > 2000 ? "…(truncated)" : ""));
		console.groupEnd();
	}	  
	  
	// (D) save chat log to a vault note
	async saveChatToNote(messages: { role: 'user'|'assistant'; content: string; timestamp: string }[]) {
		const folderPath = 'LLMChats';
		await this.app.vault.createFolder(folderPath).catch(() => {});
		const title = `Chat - ${new Date().toISOString().replace(/[:.]/g, '-')}`;
		const filePath = `${folderPath}/${title}.md`;
	  
		const md = `---
	  model: llama3
	  created: ${new Date().toISOString()}
	  ---
	  
	  ${messages.map(m => `**${m.role === 'user' ? 'You' : 'LLaMA'}** (${m.timestamp}):\n${m.content}`).join('\n\n')}
	  `;
		await this.app.vault.create(filePath, md);
	}

	// ===== Folder constants =====
	private PAPERS_DIR = "01_papers";
	private PERSONS_DIR = "02_persons";
	private CONF_DIR = "03_conferences";
	private QUELLEN_DIR = "04_quellen";

	private async ensureFolder(path: string) {
	const existing = this.app.vault.getAbstractFileByPath(path);
	if (!existing) {
		await this.app.vault.createFolder(path).catch(() => {});
	}
	}

	private extractDOI(text: string): string | null {
		// very common DOI regex
		const m = text.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i);
		return m ? m[0].replace(/[)\].,;]+$/, "") : null;
	}
	  
	private extractArxiv(text: string): string | null {
		// new style: 1234.56789 or 1234.5678v2
		const m1 = text.match(/\barXiv:\s*(\d{4}\.\d{4,5}(v\d+)?)\b/i);
		if (m1) return m1[1];
	  
		// sometimes just the id appears
		const m2 = text.match(/\b(\d{4}\.\d{4,5}(v\d+)?)\b/);
		if (m2) return m2[1];
	  
		// legacy arxiv (rare nowadays): hep-th/9901001
		const m3 = text.match(/\b([a-z\-]+\/\d{7}(v\d+)?)\b/i);
		return m3 ? m3[1] : null;
	}	  

	private async findNoteByBasenameInFolder(folder: string, basename: string): Promise<TFile | null> {
		const safe = this.sanitizeFileName(basename);
		const targetPath = `${folder}/${safe}.md`;
		const af = this.app.vault.getAbstractFileByPath(targetPath);
		return (af instanceof TFile) ? af : null;
	}

	private parseFrontmatter(text: string): { fm: any; body: string; hasFM: boolean } {
	const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
	if (!m) return { fm: {}, body: text, hasFM: false };
	try {
		const fm = yaml.load(m[1]) ?? {};
		const body = text.slice(m[0].length);
		return { fm, body, hasFM: true };
	} catch {
		return { fm: {}, body: text, hasFM: true };
	}
	}

	private buildFrontmatter(fm: any): string {
	// js-yaml dumped YAML is okay; but we keep a stable style:
	const dumped = yaml.dump(fm, { lineWidth: 1000 });
	return `---\n${dumped}---\n\n`;
	}

	private async upsertNote(
		folder: string,
		basename: string,
		buildNew: () => { frontmatter: any; body?: string },
		updateExisting: (frontmatter: any, body: string) => { frontmatter: any; body: string }
		): Promise<TFile> {
			await this.ensureFolder(folder);

			const safeBase = this.sanitizeFileName(basename);
			const path = `${folder}/${safeBase}.md`;

			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				const txt = await this.app.vault.read(existing);
				const { fm, body } = this.parseFrontmatter(txt);

				const updated = updateExisting(fm ?? {}, body ?? "");
				const out = this.buildFrontmatter(updated.frontmatter) + (updated.body ?? "");
				await this.app.vault.modify(existing, out);
				return existing;
			}

			const created = buildNew();
			const out = this.buildFrontmatter(created.frontmatter) + (created.body ?? "");
			return await this.app.vault.create(path, out);
	}

	// ===== Paper list helper (for person/conf notes) =====
	private ensurePapersArray(fm: any): string[] {
		const v = fm?.papers;
		if (!v) return [];
		if (Array.isArray(v)) return v.map(x => String(x));
		return [String(v)];
	}

	private addPaperToFrontmatterList(fm: any, paperTitle: string) {
	const papers = this.ensurePapersArray(fm);
	const link = `[[${paperTitle.replace(/"/g, "'")}]]`;
	if (!papers.some(p => p.toLowerCase() === link.toLowerCase())) {
		papers.push(link);
	}
	fm.papers = papers;
	}

	// ===== Email extraction =====
	private extractEmails(text: string): string[] {
	const rx = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g;
	const found = (text.match(rx) ?? []).map(s => s.trim());
	// unique
	return Array.from(new Set(found));
	}

	/**
	 * Versucht, den Abschnitt "References" oder "Bibliography" am Ende des Textes zu isolieren.
	 * Sucht im letzten Drittel des Textes, um False Positives im Inhaltsverzeichnis zu vermeiden.
	 */
	private extractReferencesBlock(fullText: string): string[] {
		if (!fullText || fullText.length < 500) return [];

		// Wir schauen uns nur die letzten 40% des Textes an, um Performance zu sparen 
		// und das Inhaltsverzeichnis am Anfang zu ignorieren.
		const searchArea = fullText.slice(Math.floor(fullText.length * 0.6));
		
		// Regex für typische Überschriften (case-insensitive)
		// Erlaubt: "References", "Bibliography", "Literature", "Cited Works"
		// Muss auf einer eigenen Zeile stehen (oder fast).
		const refHeaderRegex = /(?:^|\n)\s*(?:[0-9]*\.?)\s*(?:References|Bibliography|Literatur|LITERATURVERZEICHNIS|Quellenverzeichnis)\s*(?:\n|$)/i;

		const match = searchArea.match(refHeaderRegex);

		if (match && match.index !== undefined) {
			// Wir haben den Header gefunden. Wir nehmen alles danach.
			// Wir addieren den Offset (0.6 * length) wieder dazu.
			const absoluteIndex = Math.floor(fullText.length * 0.6) + match.index;
			const referencesText = fullText.slice(absoluteIndex + match[0].length);
			
			// Optional: Rauschen bereinigen (Seitenzahlen etc.)
			return [referencesText.trim()];
		}

		return [];
	}

	private parseReferenceEntry(entry: string): {
		title?: string;
		authors?: string[];
		year?: string;
		venue?: string;
		doi?: string;
		arxiv?: string;
	  } {
		const out: any = {};
	  
		out.doi = this.extractDOI(entry) ?? undefined;
		out.arxiv = this.extractArxiv(entry) ?? undefined;
	  
		// Year
		const y = entry.match(/\b(19|20)\d{2}\b/);
		if (y) out.year = y[0];
	  
		// Authors heuristic
		let authorsPart = "";
		if (y && y.index != null) authorsPart = entry.slice(0, y.index).trim();
		else {
		  const p = entry.indexOf(".");
		  authorsPart = p > 0 ? entry.slice(0, p).trim() : "";
		}
		authorsPart = authorsPart.replace(/^\[?\d{1,4}\]?[.)]\s+/, "").trim();
		if (authorsPart) {
		  const a = authorsPart
			.split(/,\s+| and /i)
			.map(s => s.trim())
			.filter(Boolean);
		  if (a.length) out.authors = a;
		}
	  
		// Title heuristic
		const q = entry.match(/“([^”]{6,200})”|"([^"]{6,200})"/);
		if (q) out.title = (q[1] || q[2]).trim();
	  
		if (!out.title) {
		  const afterYear = entry.match(/\(\s*(19|20)\d{2}\s*\)\.?\s*([^\.]{10,220})\./);
		  if (afterYear) out.title = afterYear[2].trim();
		}
		if (!out.title) {
		  const parts = entry.replace(/^\[?\d{1,4}\]?[.)]\s+/, "").split(".");
		  if (parts.length >= 2) {
			const cand = parts[1].trim();
			if (cand.length >= 10) out.title = cand.slice(0, 220);
		  }
		}
	  
		// Venue heuristic
		const venue =
		  entry.match(/\bIn\s+(Proceedings of|Proc\.?|ACM|IEEE)[^.,;]{5,160}/i)?.[0] ??
		  entry.match(/\b(ACM|IEEE|Springer|Elsevier)[^.,;]{5,160}/i)?.[0];
		if (venue) out.venue = venue.trim();
	  
		return out;
	}
	
	private async findPaperByDoiOrArxiv(doi?: string, arxiv?: string): Promise<TFile | null> {
		if (!doi && !arxiv) return null;
	  
		const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(`${this.PAPERS_DIR}/`));
		for (const f of files) {
		  try {
			const txt = await this.app.vault.read(f);
			const { fm } = this.parseFrontmatter(txt);
			const fDoi = (fm?.doi ? String(fm.doi) : "");
			const fArxiv = (fm?.arxiv ? String(fm.arxiv) : "");
	  
			if (doi && fDoi && fDoi.toLowerCase() === doi.toLowerCase()) return f;
			if (arxiv && fArxiv && fArxiv.toLowerCase() === arxiv.toLowerCase()) return f;
		  } catch {}
		}
		return null;
	}
	
	/**
     * Zerlegt einen Namen in Vorname (oder Initial) und Nachname.
     * Erkennt "Otto, Boris" -> {first: "Boris", last: "Otto"}
     * Erkennt "Boris Otto" -> {first: "Boris", last: "Otto"}
     */
    private parseName(rawName: string): { first: string; last: string } {
        let clean = rawName.replace(/\./g, "").trim(); // Punkte entfernen (B. -> B)
        
        // Fall 1: "Nachname, Vorname" (Komma vorhanden)
        if (clean.includes(",")) {
            const parts = clean.split(",").map(s => s.trim());
            return { 
                last: parts[0].toLowerCase(), 
                first: parts.length > 1 ? parts[1].toLowerCase() : "" 
            };
        }

        // Fall 2: "Vorname Nachname" (Kein Komma, letztes Wort ist Nachname)
        const parts = clean.split(" ");
        if (parts.length === 1) {
            return { last: parts[0].toLowerCase(), first: "" };
        }
        
        const last = parts.pop()!.toLowerCase();
        const first = parts.join(" ").toLowerCase();
        return { last, first };
    }

	private async findExistingAuthorFile(nameToFind: string): Promise<TFile | null> {
        const target = this.parseName(nameToFind);
        if (!target.last) return null;

        // Alle Dateien im People-Ordner holen
        // (Achtung: Ersetze 'this.PEOPLE_DIR' durch deine Variable für den Autoren-Ordner)
        const files = this.app.vault.getMarkdownFiles().filter(f => 
            f.path.startsWith(this.PERSONS_DIR)
        );

        for (const file of files) {
            // Wir parsen den Dateinamen der existierenden Notiz
            const existingName = this.parseName(file.basename);

            // 1. Check: Nachnamen müssen übereinstimmen
            if (existingName.last !== target.last) continue;

            // 2. Check: Vornamen Match-Logik
            const f1 = target.first;      // z.B. "b" (von Otto, B.)
            const f2 = existingName.first; // z.B. "boris" (von Boris Otto)

            // Wenn einer gar keinen Vornamen hat -> Wir nehmen an, es ist dieselbe Person (vorsichtig)
            if (!f1 || !f2) return file;

            // Prüfen, ob einer der Vornamen mit dem anderen beginnt (Initial-Check)
            // "boris".startsWith("b") -> TRUE
            // "b".startsWith("boris") -> FALSE (aber wir checken beide Richtungen)
            if (f1.startsWith(f2) || f2.startsWith(f1)) {
                return file;
            }
        }

        return null;
    }

	private sanitizeFileName(name: string): string {
		if (!name) return "Untitled";

		let clean = name
			// 1. Doppelpunkte durch " - " ersetzen (schöner, aber länger)
			.replace(/[:]/g, " - ")
			// 2. Slashes durch Bindestrich
			.replace(/[\\/]/g, "-")
			// 3. Verbotene Zeichen entfernen
			.replace(/[*"<>|?]/g, "")
			// 4. Doppelte Leerzeichen entfernen
			.replace(/\s+/g, " ")
			.trim();

		// 5. SICHERHEITS-CUT: Maximale Länge für Windows Dateinamen erzwingen
		// 150 Zeichen lassen genug Platz für den Pfad (C:\Users\...)
		if (clean.length > 150) {
			clean = clean.substring(0, 150).trim();
		}

		return clean;
	}

	async upsertPersonNote(rawName: string, sourcePaperTitle: string) {
        const cleanName = this.normalizeAuthorName(rawName);
        if (!cleanName) return;

        // 1. Suche nach existierender Datei (Intelligent)
        let file = await this.findExistingAuthorFile(cleanName);

        // Ordner sicherstellen
        await this.ensureFolder(this.PERSONS_DIR);

        if (file) {
            // OPTIONALES FEATURE: Automatisches Umbenennen zu besserem Namen
            // Wenn die Datei "Otto, B." heißt, aber wir jetzt "Boris Otto" haben -> Umbenennen!
            const currentParse = this.parseName(file.basename);
            const newParse = this.parseName(cleanName);
            
            // Wenn der neue Vorname länger ist als der alte (B. vs Boris), benennen wir um
            if (newParse.first.length > currentParse.first.length && newParse.last === currentParse.last) {
                const newPath = `${this.PERSONS_DIR}/${this.sanitizeFileName(cleanName)}.md`;
                // Prüfen ob Zielpfad frei ist (sicherheitshalber)
                if (!this.app.vault.getAbstractFileByPath(newPath)) {
                    await this.app.fileManager.renameFile(file, newPath);
                    file = this.app.vault.getAbstractFileByPath(newPath) as TFile;
                    new Notice(`Renamed author to more complete name: ${file.basename}`);
                }
            }
        } else {
            // 2. Wenn nicht gefunden -> Neue Datei erstellen
            // Wir bevorzugen das Format "Vorname Nachname" für den Dateinamen
            // Falls der Input "Otto, B." war, drehen wir es hier um für den Dateinamen
            const parsed = this.parseName(cleanName);
            const fileNameStr = parsed.first ? `${parsed.first} ${parsed.last}` : parsed.last;
            
            // Wörter großschreiben (Title Case) für schönen Dateinamen
            const niceFileName = fileNameStr.replace(/\b\w/g, l => l.toUpperCase());
            
            const path = `${this.PERSONS_DIR}/${this.sanitizeFileName(niceFileName)}.md`;
            
            const content = 
`---
tags:
  - type/person
  - source/automatic
date: ${new Date().toISOString().slice(0, 10)}
---

# ${niceFileName}

## Associated Papers
`;
            file = await this.app.vault.create(path, content);
        }

        // 3. Backlink zum Paper hinzufügen (Append)
        // Wir prüfen, ob das Paper schon in der Notiz steht, um Duplikate im Text zu vermeiden
        const content = await this.app.vault.read(file);
        const linkText = `[[${sourcePaperTitle}]]`;
        
        if (!content.includes(linkText)) {
            await this.app.vault.append(file, `\n- ${linkText}`);
        }
    }

	// ===== Upsert conference note =====
	private async upsertConferenceNote(confTitle: string, year: string, paperTitle: string) {
	const base = this.sanitizeFileName(confTitle);
	await this.upsertNote(
		this.CONF_DIR,
		base,
		() => {
		const fm: any = {
			title: `[[${confTitle.replace(/"/g, "'")}]]`,
			year: year || "Unknown Year",
			tags: ["type/conference"],
			papers: []
		};
		this.addPaperToFrontmatterList(fm, paperTitle);
		return {
			frontmatter: fm,
			body: `# ${confTitle}\n\n`
		};
		},
		(fm, body) => {
		fm.tags = Array.from(new Set([...(fm.tags ?? []), "type/conference"]));
		if (year && (!fm.year || fm.year === "Unknown Year")) fm.year = year;
		this.addPaperToFrontmatterList(fm, paperTitle);
		return { frontmatter: fm, body: body || `# ${confTitle}\n\n` };
		}
	);
	}
	
	private async findExistingPaperNote(title: string): Promise<TFile | null> {
		const sanitizedTitle = this.sanitizeFileName(title).toLowerCase();
		const searchFolders = [this.PAPERS_DIR, this.QUELLEN_DIR];
		
		const files = this.app.vault.getMarkdownFiles();
		return files.find(f => {
			const isInFolder = searchFolders.some(folder => f.path.startsWith(folder));
			// Vergleich des Dateinamens (case-insensitive)
			return isInFolder && f.basename.toLowerCase() === sanitizedTitle;
		}) || null;
	}

	private async extractStructuredReferences(referencesRaw: string): Promise<any[]> {
		// Kürzen, um Token zu sparen
		const truncatedRefs = referencesRaw.slice(0, 15000);

		// PROMPT UPDATE: Viel strenger ("JSON ONLY", "NO CONVERSATION")
		const refPrompt = `You are a machine that outputs strict JSON. You do not speak.
Task: Extract academic references from the text below.

INPUT TEXT:
${truncatedRefs}

INSTRUCTIONS:
1. Identify academic papers/books. Ignore websites or incomplete garbage.
2. Fix broken lines (merge titles).
3. Extract fields: Title, Authors (list), Year, Venue.
4. OUTPUT FORMAT: STRICT JSON Array. Do NOT use Markdown code blocks. Do NOT write an intro.
Example:
[{"title": "Deep Learning", "authors": ["LeCun, Y.", "Bengio, Y."], "year": "2015", "venue": "Nature", "isAcademic": true}]

JSON OUTPUT:`;
	
		const response = await this.processWithLlama3(refPrompt);
		const content = response.message.content;

		try {
			// VERSUCH 1: JSON Extraktion (Der ideale Weg)
			// Sucht nach [...] und ignoriert Text davor/danach
			const jsonMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
			if (jsonMatch) {
				return JSON.parse(jsonMatch[0]);
			}
			
			// Wenn wir hier sind, hat das LLM kein JSON geliefert.
			console.warn("LLM did not return JSON. Trying text fallback parsing...");
			
			// VERSUCH 2: Fallback für nummerierte Listen (wie in deinem Log)
			return this.parseFallbackTextList(content);

		} catch (e) {
			console.error("Failed to parse reference data", e);
			return [];
		}
	}

	// NEUE HILFSFUNKTION: Parsed nummerierte Listen, wenn JSON fehlschlägt
	private parseFallbackTextList(text: string): any[] {
		const results: any[] = [];
		
		// Regex für typische Einträge: "1. Author (Year). Title. Venue."
		// Passt auf Zeilen, die mit Zahl+Punkt oder [Zahl] beginnen
		const lines = text.split('\n');
		
		for (const line of lines) {
			const cleanLine = line.trim();
			if (cleanLine.length < 20) continue;

			// Heuristik: Suche nach Jahreszahl in Klammern (20xx)
			const yearMatch = cleanLine.match(/\((19|20)\d{2}[a-z]?\)/);
			
			if (yearMatch) {
				// Wir versuchen grob zu splitten
				const year = yearMatch[1]; // "2022"
				const yearIndex = yearMatch.index || 0;
				
				// Alles VOR dem Jahr sind meist die Autoren
				let authorsRaw = cleanLine.substring(0, yearIndex).replace(/^\d+\.|^\[\d+\]/, '').trim();
				// Bereinigen von führenden Punkten/Kommas
				authorsRaw = authorsRaw.replace(/[.,;:]+$/, "");
				
				const authors = authorsRaw.split(/,|&|\sand\s/).map(a => a.trim()).filter(a => a.length > 2);

				// Alles NACH dem Jahr (plus Klammer zu) ist Titel + Venue
				const rest = cleanLine.substring(yearIndex + yearMatch[0].length).trim();
				
				// Versuch, Titel vom Venue zu trennen (erster Punkt nach Titel)
				// Strategie: Nimm alles bis zum ersten Punkt als Titel
				const firstDotIndex = rest.indexOf('.');
				let title = "";
				let venue = "";

				if (firstDotIndex > 5) {
					title = rest.substring(0, firstDotIndex).replace(/^\.\s*/, "").trim();
					venue = rest.substring(firstDotIndex + 1).trim();
				} else {
					title = rest; // Fallback: Alles ist Titel
				}

				// Rauschen entfernen (Bindestriche am Anfang)
				title = title.replace(/^[-–—]\s*/, "");

				if (title.length > 5) {
					results.push({
						title: title,
						authors: authors,
						year: year,
						venue: venue,
						isAcademic: true
					});
				}
			}
		}
		
		return results;
	}
	
	private async upsertCitedPaperNote(meta: {
		title?: string; authors?: string[]; year?: string; venue?: string;
	}) {
		const rawTitle = (meta.title ?? "").trim();
		// Filter: Titel zu kurz oder sieht aus wie ein Autor?
		if (!rawTitle || rawTitle.length < 10) return;
		if (rawTitle.split(" ").length < 3 && rawTitle.includes(",")) return; // Schutz vor "Müller, T." als Titel

		// 1. Suche nach existierender Notiz
		const existingNote = await this.findExistingPaperNote(rawTitle);
		if (existingNote) {
			console.log(`Reference already exists: ${existingNote.path}`);
			return; // Nichts tun, wenn es schon existiert
		}

		await this.ensureFolder(this.QUELLEN_DIR);

		// Dateiname bereinigen
		const baseName = this.sanitizeFileName(rawTitle);
		const path = `${this.QUELLEN_DIR}/${baseName}.md`;

		// Metadaten vorbereiten
		const createdDate = new Date().toISOString().slice(0, 10);
		
		// Wikilinks formatieren
		const authorLinks = Array.isArray(meta.authors) 
			? meta.authors.map(a => `[[${this.normalizeAuthorName(a)}]]`) 
			: [];
		const venueLink = meta.venue ? `[[${meta.venue.replace(/"/g, "'")}]]` : "";
		const titleLink = `[[${rawTitle.replace(/"/g, "'")}]]`;

		// YAML Frontmatter manuell bauen für maximale Kontrolle (analog zu handleDroppedPDF)
		const yamlFrontmatter = [
			"---",
			`title: "${titleLink}"`,
			`date: ${createdDate}`,
			"author:",
			...authorLinks.map(a => `  - "${a.replace(/"/g, "'")}"`),
			...(venueLink ? [`conference: "${venueLink}"`] : []),
			`year: ${meta.year || "Unknown"}`,
			"tags:",
			"  - type/paper",
			"  - source/reference", // Unterscheidung: Dies ist eine importierte Referenz
			"  - status/toread",
			"---",
			"",
			`# ${rawTitle}`,
			"",
			"## Summary",
			"_Automatically extracted reference from a parent PDF._",
			""
		].join("\n");

		// Datei erstellen
		await this.app.vault.create(path, yamlFrontmatter);
		
		// Optional: Auch für diese Autoren Person-Notes anlegen
		if (meta.authors) {
			for (const authorName of meta.authors) {
				const normName = this.normalizeAuthorName(authorName);
				if (normName) await this.upsertPersonNote(normName, rawTitle);
			}
		}
	}

	async handleDroppedPDF(file: File) {
		try {
			const loadingModal = new DragAndDropModal(this.app, `<i>Loading PDF and extracting metadata...</i>`);
			loadingModal.open();
	
			const fileBuffer = await file.arrayBuffer();
			const metadataBuffer = fileBuffer.slice(0);
			const binaryBuffer = fileBuffer.slice(0);
			const { text: pdfText, metadata: pdfInternalMetadata } = await this.extractPDFContent(metadataBuffer);
	
			const title = file.name.replace(/\.pdf$/i, "").trim();
			const cleanedText = await this.preCleanText(pdfText);
			const firstChunk = cleanedText.slice(0, 8000); // For metadata
	
			// === Step 1: Metadata Extraction ===
			const llamaPrompt = `Extract the following metadata from this academic paper content. ONLY return in this format:
	Authors: [List of authors separated by commas]
	Conference: [Conference or Journal Name]
	Keywords: [List of keywords separated by commas]
	Emails: [List of emails separated by commas OR leave empty if none]
	
	--- START OF PAPER ---
	${firstChunk}
	--- END OF PAPER ---`;
	
			const llamaResponse = await this.processWithLlama3(llamaPrompt);
			const content = llamaResponse.message.content.trim();
	
			const authorsMatch = content.match(/Authors:\s*(.+)/i);
			const confMatch = content.match(/Conference:\s*(.+)/i);
			const keywordsMatch = content.match(/Keywords:\s*(.+)/i);
			const emailsMatch = content.match(/Emails:\s*(.*)/i);
			let emails = emailsMatch ? emailsMatch[1].split(/[,;]/).map(e => e.trim()).filter(Boolean) : [];

			// fallback: regex-scan im firstChunk (sehr zuverlässig bei PDFs)
			if (!emails.length) emails = this.extractEmails(firstChunk);
	
			const authors = authorsMatch ? authorsMatch[1].split(/,| and /).map(a => a.trim()) : ["Unknown Author"];
			const normalizedAuthors = authors
			.map(a => this.normalizeAuthorName(a))
			.filter(a => !!a);

			const finalAuthors = normalizedAuthors.length ? normalizedAuthors : ["Unknown Author"];
			const conferenceOrJournal = confMatch ? confMatch[1].trim() : "Unknown Conference/Journal";
			const keywords = keywordsMatch ? keywordsMatch[1].split(/[,;]/).map(k => k.trim()).filter(Boolean) : ["N/A"];
	
			const year =
				(typeof pdfInternalMetadata.year === "string" && pdfInternalMetadata.year.trim() !== "")
					? pdfInternalMetadata.year
					: "Unknown Year";
	
					// === Vorbereitung der Daten ===
					const createdDate = new Date().toISOString().slice(0, 10);

					// Optional: als Wikilinks anzeigen (wie im Properties-UI als klickbare Chips)
					const titleLink = `[[${title.replace(/"/g, "'")}]]`;
					const authorLinks = finalAuthors.map(a => `[[${a}]]`);
					const conferenceLink = `[[${conferenceOrJournal.replace(/"/g, "'")}]]`;
					const keywordLinks = keywords.map(k => `[[${k}]]`);
					
					const yamlFrontmatter = [
		"---",
		`title: "${titleLink}"`, 
		`date: ${createdDate}`,               // Obsidian mag "date" sehr (dein Screenshot nutzt date)
		"author:",                            // Singular wie in deinem "richtigen" Screenshot
		...authorLinks.map(a => `  - "${a.replace(/"/g, "'")}"`),
		...(emails.length
			? ["emails:", ...emails.map(e => `  - "${e.replace(/"/g, "'")}"`)]
			: []),
		`conference: "${conferenceLink}"`,
		"keywords:",
		...keywordLinks.map(k => `  - "${k.replace(/"/g, "'")}"`),
		`year: ${String(year).replace(/"/g, "")}`,
		`source_file: "${file.name.replace(/"/g, "'")}"`,
		"tags:",
		"  - type/paper",
		"  - source/pdf",
		"  - status/imported",
		`template_version: "1.0"`,
		"---",
		"" // Leerzeile nach Frontmatter
	].join("\n");					
	
			// === Step 2: Summarize in Chunks ===
			loadingModal.updateContent(`<i>Metadata extracted. Summarizing full paper in chunks...</i>`);
	
			const maxChunkSize = 8000;
			const chunks: string[] = [];
			for (let i = 0; i < cleanedText.length; i += maxChunkSize) {
				chunks.push(cleanedText.slice(i, i + maxChunkSize));
			}
	
			const summaries: string[] = [];
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				loadingModal.updateContent(`<i>Summarizing chunk ${i + 1} of ${chunks.length}...</i>`);
				const chunkPrompt = `Summarize the following part of an academic paper:
	---
	${chunk}
	---`;
	
				const chunkResponse = await this.processWithLlama3(chunkPrompt);
				summaries.push(chunkResponse.message.content.trim());
			}
	
			// === Final Summary Consolidation ===
			loadingModal.updateContent(`<i>Consolidating summaries into a final paragraph...</i>`);
			const consolidatePrompt = `You are given several partial summaries from chunks of an academic paper. Combine them into one concise, cohesive summary paragraph.
			
	--- PARTIAL SUMMARIES ---
	${summaries.map((s, idx) => `Summary ${idx + 1}: ${s}`).join('\n\n')}
	--- END ---`;

			// Extraktion der Blöcke
			const refsRaw = this.extractReferencesBlock(cleanedText).join("\n");

			if (refsRaw.length > 100) {
				loadingModal.updateContent(`<i>Prüfe Referenzen auf wissenschaftliche Relevanz...</i>`);
				
				const extractedRefs = await this.extractStructuredReferences(refsRaw);

				for (const ref of extractedRefs) {
					// Validierung: Nur wenn es ein akademisches Werk ist und der Titel kein Autor ist
					if (ref.isAcademic && ref.title && ref.title.length > 10) {
						
						// Check: Ist der Titel vielleicht nur ein Name? (Heuristik)
						const isJustNames = ref.title.split(" ").length < 3 && ref.title.includes(",");
						if (isJustNames) continue;

						await this.upsertCitedPaperNote(ref);
					}
				}
			}
	
			const finalSummaryResponse = await this.processWithLlama3(consolidatePrompt);
			const finalSummary = finalSummaryResponse.message.content.trim();
			const summaryBlock = `## Summary\n${finalSummary}`;
			
			// === ZITATE & REFERENZEN EXTRAHIEREN ===
			// Wir nutzen den fullText (cleanedText), um am Ende nach Referenzen zu suchen
			const refBlockRaw = this.extractReferencesBlock(cleanedText);
			
			if (refBlockRaw.length > 0 && refBlockRaw[0].length > 100) {
				loadingModal.updateContent(`<i>🔍 Found references. Analyzing and creating notes for cited papers...</i>`);
				
				// LLM Aufruf zum Parsen
				const extractedRefs = await this.extractStructuredReferences(refBlockRaw[0]);
				
				let createdCount = 0;
				// Iteriere über gefundene Referenzen
				for (const ref of extractedRefs) {
					// Nur verarbeiten, wenn es explizit als akademisch erkannt wurde
					if (ref.isAcademic) {
						await this.upsertCitedPaperNote(ref);
						createdCount++;
					}
				}
				console.log(`Created ${createdCount} new notes from references.`);
			} else {
				console.log("No reference section found or too short.");
			}

			// === Save PDF to Vault ===
			const pdfFolder = "pdf";
			let folderExists = this.app.vault.getAbstractFileByPath(pdfFolder);
			if (!folderExists) {
				await this.app.vault.createFolder(pdfFolder);
			}
	
			const pdfFileName = `${pdfFolder}/${file.name}`;
			let vaultPdfFile = this.app.vault.getAbstractFileByPath(pdfFileName);
			if (!vaultPdfFile) {
				await this.app.vault.createBinary(pdfFileName, binaryBuffer);
			} else {
				console.warn(`PDF file already exists in vault: ${pdfFileName}`);
			}
	
			const pdfEmbed = `![[${pdfFileName}]]`;
	
			// ... (Vorheriger Code in handleDroppedPDF: Metadata extraction, Summary, PDF binary saving) ...

			// === Final Note Body ===
			// Das ist der neue, vollständige Inhalt (Metadata + Summary + PDF Embed)
			const noteBody =
  yamlFrontmatter +
`## Summary
${finalSummary}

## Full Text Extracted from PDF
${cleanedText}

## PDF Viewer
${pdfEmbed}
`;
	
			// === NEUE LOGIK: Check, Move & Upgrade ===
			
			// 1. Wir suchen nach einer existierenden Notiz (in 01_papers ODER 04_quellen)
			const existingNote = await this.findExistingPaperNote(title);

			let finalFile: TFile;

			if (existingNote) {
				// Prüfen, wo die Datei liegt
				const isInQuellen = existingNote.path.startsWith(this.QUELLEN_DIR);
				const isInPapers = existingNote.path.startsWith(this.PAPERS_DIR);

				if (isInPapers) {
					// FALL A: Datei ist schon im Papers-Ordner -> Nichts tun, nur öffnen
					new Notice("Paper already exists in library.");
					finalFile = existingNote;
				} 
				else if (isInQuellen) {
					// FALL B: Datei ist eine Referenz -> UPGRADE durchführen
					loadingModal.updateContent(`<i>Found existing reference in ${this.QUELLEN_DIR}. Promoting to full paper...</i>`);
					
					// 1. Verschieben nach 01_papers
					// app.fileManager.renameFile kümmert sich um das Verschieben und aktualisiert Links!
					const newPath = `${this.PAPERS_DIR}/${existingNote.name}`;
					await this.app.fileManager.renameFile(existingNote, newPath);
					
					// 2. Inhalt aktualisieren (Die alte Referenz-Notiz wird mit dem vollen Inhalt überschrieben)
					// Wir warten kurz, damit Filesystem-Operationen sauber durchlaufen
					await new Promise(r => setTimeout(r, 100));
					await this.app.vault.modify(existingNote, noteBody);
					
					new Notice(`Upgraded reference to full paper: ${title}`);
					finalFile = existingNote;
				} else {
					// Fallback: Datei woanders gefunden? Trotzdem öffnen.
					finalFile = existingNote;
				}

			} else {
				// FALL C: Datei existiert noch gar nicht -> Neu erstellen
				await this.ensureFolder(this.PAPERS_DIR);
				const noteFileName = `${this.PAPERS_DIR}/${this.sanitizeFileName(title)}.md`;
				
				// Sicherheitshalber nochmal checken (AbstractFile), falls findExistingPaperNote was übersehen hat
				const checkAgain = this.app.vault.getAbstractFileByPath(noteFileName);
				if (checkAgain instanceof TFile) {
					finalFile = checkAgain; // Sollte theoretisch nicht passieren dank Logic oben
				} else {
					finalFile = await this.app.vault.create(noteFileName, noteBody);
					new Notice(`Imported new paper: ${title}`);
				}
			}

			// ✅ Person & Conference Notes aktualisieren (wie gehabt)
			for (const a of finalAuthors) {
				if (a && a !== "Unknown Author") {
					await this.upsertPersonNote(a, title);
				}
			}
			if (conferenceOrJournal && conferenceOrJournal !== "Unknown Conference/Journal") {
				await this.upsertConferenceNote(conferenceOrJournal, String(year), title);
			}  

			// Force open the note in a leaf
			if (finalFile) {
				const leaf = this.app.workspace.getLeaf(true);
				await leaf.openFile(finalFile);
			}

			loadingModal.close();
			
		} catch (error: any) {
			// Error Handling wie gehabt...
			const msg = String(error?.message ?? error);
			if (msg.toLowerCase().includes("file already exists")) {
			  new Notice("The file operation failed (File exists).");
			} else {
			  new Notice("Failed to process dropped PDF: " + msg);
			}
			console.error("Error processing dropped PDF:", error);
			// Falls Modal noch offen ist, schließen
			// (Hier bräuchte man Zugriff auf die Instanz, falls sie scope-technisch noch da ist)
		}
	}

	private normalizeAuthorName(raw: string): string {
		let s = (raw ?? "").trim();
	  
		// drop emails and affiliation-like tails
		s = s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g, "").trim();
		s = s.replace(/\b(university|institute|department|lab|laboratory|gmbh|inc\.|ltd\.|company)\b.*$/i, "").trim();
	  
		// remove trailing punctuation
		s = s.replace(/[.,;:]+$/g, "").trim();
	  
		// very short / garbage
		if (s.length < 3) return "";
	  
		return s;
	}	  
	
	async addRelevanceAnalysisButton(noteFile: TFile) {
		const noteText = await this.app.vault.read(noteFile);
		const metadataEndIndex = noteText.indexOf('##');
		if (metadataEndIndex === 0) return;
	
		const buttonText = "Find Related Papers";
	
		if (noteText.includes(buttonText)) return;
	
		const buttonMarkdown = `\n\n<button class="relevance-button">${buttonText}</button>\n\n`;
		const updatedNote = noteText.slice(0, metadataEndIndex) + buttonMarkdown + noteText.slice(metadataEndIndex);
		await this.app.vault.modify(noteFile, updatedNote);
	
		// Ensure button is clickable by delaying to wait for render
		setTimeout(() => {
			const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!markdownView) return;
	
			const container = markdownView.contentEl;
			const button = container.querySelector('.relevance-button');
			if (button) {
				button.addEventListener('click', async () => {
					await this.runRelevanceAnalysis(noteFile);
				});
			}
		}, 500); // wait for render
	}		

	async runRelevanceAnalysis(currentFile: TFile) {
		const currentNoteText = await this.app.vault.read(currentFile);
		const currentSummary = this.extractSummaryFromNoteText(currentNoteText);
	  
		if (!currentSummary) {
		  new Notice("No summary found in current note.");
		  return;
		}
	  
		const allFiles = this.app.vault.getMarkdownFiles();
		const others: { file: TFile; title: string; summary: string }[] = [];
	  
		for (const file of allFiles) {
		  if (file.path === currentFile.path) continue;
	  
		  const text = await this.app.vault.read(file);
		  const sum = this.extractSummaryFromNoteText(text);
		  if (!sum) continue;
	  
		  // Wichtig: Summary begrenzen, sonst zu langer Prompt
		  const trimmed = sum.length > 2500 ? sum.slice(0, 2500) : sum;
	  
		  others.push({ file, title: file.basename, summary: trimmed });
		}
	  
		if (others.length === 0) {
		  new Notice("No other notes with summaries found.");
		  return;
		}
	  
		const loadingModal = new DragAndDropModal(this.app, "Looking for relevant papers...");
		loadingModal.open();
	  
		try {
		  // Liste begrenzen (sonst Prompt explodiert)
		  const MAX_CANDIDATES = 60;
		  const candidates = others.slice(0, MAX_CANDIDATES);
	  
		  const numbered = candidates
			.map((s, i) => `${i + 1}) Title: ${s.title}\nSummary: ${s.summary}`)
			.join("\n\n");
	  
		  const prompt = `
		  You are given one academic paper summary and a list of other paper summaries. 
		  Identify which other summaries are relevant to the main one. 
		  Return ONLY the titles of the relevant ones, each on a new line. Do not add any explanation.	  
	  
	  Main Summary:
	  ${currentSummary.length > 3000 ? currentSummary.slice(0, 3000) : currentSummary}
	  
	  Other Summaries (numbered):
	  ${numbered}
	  `.trim();
	  
		  const response = await this.processWithLlama3(prompt);
	  
		  const raw = (response.message.content || "").trim();
	  
		  // numbers like: "2, 5, 9" or lines with "2" "5"
		  const nums = Array.from(raw.matchAll(/\b(\d{1,3})\b/g)).map(m => parseInt(m[1], 10));
		  const uniq = Array.from(new Set(nums)).filter(n => n >= 1 && n <= candidates.length).slice(0, 12);
	  
		  const relevantTitles = uniq.map(n => candidates[n - 1].title);
	  
		  const relatedBlock =
			`> [!Relevant papers]\n> ${
			  relevantTitles.length ? relevantTitles.map(t => `[[${t}]]`).join("\n> ") : "None found."
			}`;
	  
		  // Insert block just before ## Summary, but remove old block first
		  const summaryIndex = currentNoteText.search(/##\s*Summary/i);
		  if (summaryIndex === -1) {
			new Notice("Could not find Summary section to insert before.");
			return;
		  }
	  
		  const beforeSummary = currentNoteText.slice(0, summaryIndex).trimEnd();
		  const afterSummary = currentNoteText.slice(summaryIndex);
	  
		  const cleanedBefore = beforeSummary.replace(
			/^\s*>\s*\[!Relevant papers\][\s\S]*?(?=\n(?!\s*>)[^\n]|\s*$)/im,
			""
		  ).trimEnd();
	  
		  const newNoteText = `${cleanedBefore}\n\n${relatedBlock}\n\n${afterSummary}`;
		  await this.app.vault.modify(currentFile, newNoteText);
	  
		  new Notice(`Relevant papers inserted (${relevantTitles.length}).`);
		} finally {
		  loadingModal.close();
		}
	}	  
	
	async listNotesWithSummary(exclude?: TFile): Promise<TFile[]> {
		const all = this.app.vault.getMarkdownFiles();
		const out: TFile[] = [];
	  
		for (const f of all) {
		  if (exclude && f.path === exclude.path) continue;
		  const text = await this.app.vault.read(f);
		  const summary = this.extractSummaryFromNoteText(text);
		  if (summary) out.push(f);
		}
	  
		// optional sort
		out.sort((a, b) => a.basename.localeCompare(b.basename));
		return out;
	}	  

	async extractPDFContent(fileBuffer: ArrayBuffer): Promise<{ text: string; metadata: any }> {
		try {
		  const loadingTask = getDocument({ data: fileBuffer });
		  const pdf = await loadingTask.promise;
	  
		  const pagesText: string[] = [];
	  
		  // --- Helper 1: Noise Filter ---
		  const isNoise = (item: PDFItem) => {
			if (!item.str.trim()) return true;
			if (item.h < 4) return true; // Winzige unsichtbare Texte
			// Optional: Filtere vertikale Seitenzahlen am Rand, falls nötig
			return false;
		  };
	  
		  // --- Helper 2: Zeilen Formatierung ---
		  // Verbindet einzelne Text-Schnipsel zu lesbaren Absätzen
		  const formatLines = (items: PDFItem[]): string => {
			if (items.length === 0) return "";
			
			// Sortiere strikt von oben nach unten, dann von links nach rechts
			items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
	  
			let out = "";
			let lastY = items[0].y;
			let lastItem: PDFItem = items[0];
	  
			for (let i = 0; i < items.length; i++) {
			  const item = items[i];
			  
			  // Logik für Zeilenumbruch:
			  // Wenn der vertikale Abstand größer ist als die halbe Höhe des Textes -> Neue Zeile
			  const yDiff = Math.abs(item.y - lastY);
			  
			  if (i > 0 && yDiff > item.h * 0.5) {
				// Prüfen, ob es ein neuer Absatz ist (größerer Abstand)
				const isParagraph = yDiff > item.h * 1.5;
				out += isParagraph ? "\n\n" : "\n";
			  } else if (i > 0) {
				// Gleiche Zeile: Leerzeichen einfügen, wenn Abstand horizontal da ist
				const xDist = item.x - (lastItem.x + lastItem.w);
				// Manchmal sind Buchstaben einzeln kodiert, daher kleiner Threshold (z.B. 2px)
				if (xDist > 2 && !item.str.startsWith(" ") && !lastItem.str.endsWith(" ")) {
				  out += " ";
				}
			  }
	  
			  out += item.str;
			  lastY = item.y;
			  lastItem = item;
			}
			return out;
		  };
	  
		  // --- Kern-Logik: Layout-Erkennung ---
		  const processPageItems = (items: PDFItem[], pageWidth: number, pageHeight: number): string => {
			  if (items.length === 0) return "";
			  
			  // 1. Footer/Header Erkennung (Heuristik)
			  // Alles was extrem weit unten (Footer) oder oben (Header) ist, 
			  // sollte separat behandelt werden, um Spaltenlogik nicht zu stören.
			  const marginY = 50; // Bereich für Header/Footer
			  const bodyItems = items.filter(i => i.y > marginY && i.y < (pageHeight - marginY));
			  const footerItems = items.filter(i => i.y <= marginY);
			  const headerItems = items.filter(i => i.y >= (pageHeight - marginY));
	  
			  // 2. Sortieren des Bodys: Wichtig! Von Oben nach Unten (Y absteigend)
			  bodyItems.sort((a, b) => b.y - a.y);
	  
			  const midX = pageWidth / 2;
			  // Toleranzbereich in der Mitte (Gutter), damit Texte die leicht überlappen nicht falsch zugeordnet werden
			  const centerTolerance = pageWidth * 0.05; 
	  
			  let outputText = "";
	  
			  // Header zuerst
			  if (headerItems.length > 0) outputText += formatLines(headerItems) + "\n\n";
	  
			  // 3. State Machine für Layout-Wechsel
			  // Wir iterieren durch die Items und sammeln sie in Gruppen.
			  // Sobald wir ein Item finden, das die Mitte kreuzt (1-Spaltig), 
			  // verarbeiten wir den bisherigen 2-Spaltigen Buffer.
			  
			  let twoColBuffer: PDFItem[] = [];
			  
			  const flushTwoColBuffer = () => {
				  if (twoColBuffer.length === 0) return;
				  
				  // Trenne Buffer in Links und Rechts
				  const leftCol = twoColBuffer.filter(i => (i.x + i.w) < (midX + centerTolerance));
				  const rightCol = twoColBuffer.filter(i => i.x > (midX - centerTolerance));
				  
				  // Sortiere und formatiere Spalten separat
				  const leftText = formatLines(leftCol);
				  const rightText = formatLines(rightCol);
	  
				  if (leftText) outputText += leftText + "\n";
				  if (rightText) outputText += rightText + "\n";
				  
				  twoColBuffer = [];
			  };
	  
			  for (const item of bodyItems) {
				  // Prüfung: Kreuzt das Item die Mitte signifikant?
				  // Ein Item ist "Wide" (1-spaltig), wenn es links beginnt und rechts endet
				  const startsLeft = item.x < (midX - centerTolerance);
				  const endsRight = (item.x + item.w) > (midX + centerTolerance);
				  const isWideItem = startsLeft && endsRight;
	  
				  if (isWideItem) {
					  // Layout-Wechsel erkannt! Erst den 2-Spalten Buffer leeren (Abarbeiten)
					  flushTwoColBuffer();
					  
					  // Dann das breite Item direkt anfügen
					  outputText += item.str + "\n"; 
				  } else {
					  // Das Item gehört zu einer Spalte -> ab in den Buffer
					  twoColBuffer.push(item);
				  }
			  }
	  
			  // Restlichen Buffer leeren
			  flushTwoColBuffer();
	  
			  // Footer zuletzt
			  if (footerItems.length > 0) outputText += "\n\n" + formatLines(footerItems);
	  
			  return outputText;
		  };
	  
	  
		  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
			const page = await pdf.getPage(pageNo);
			const viewport = page.getViewport({ scale: 1.0 });
			const content = await page.getTextContent();
			
			// Items mappen und bereinigen
			let items: PDFItem[] = (content.items as any[]).map((it) => ({
			  str: it.str,
			  x: it.transform[4],
			  y: it.transform[5],
			  w: it.width,
			  h: it.height || 10
			})).filter(i => !isNoise(i));
	  
			const pageText = processPageItems(items, viewport.width, viewport.height);
			pagesText.push(pageText);
		  }
	  
		  const fullText = pagesText.join("\n\n-- PAGE BREAK --\n\n").trim();
		  
		  // Einfache Metadaten
		  const yearMatch = fullText.match(/\b(19|20)\d{2}\b/);
		  const metadata = { year: yearMatch ? yearMatch[0] : "" };
	  
		  return { text: fullText, metadata };
	  
		} catch (error) {
		  console.error("PDF Extract Error:", error);
		  return { text: "", metadata: {} };
		}
	}			

	getTextWidth(text: string): number {
		const avgCharWidth = 5.5;
		return text.length * avgCharWidth;
	}

	/* async processWithLlama3(text: string): Promise<Llama3Response> {
		try {
			console.groupCollapsed("[LLaMA3] Request");
			console.log("Model: llama3:8b");
			this.logPreview("Prompt:", text, 600);
			console.groupEnd();
			const response = await fetch("http://153.96.23.232/ollama/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
			model: "llama3:8b",
			messages: [
				{ role: "user", content: text }
			],
			stream: false
			}),
		});
		if (!response.ok) throw new Error(`API returned ${response.status}`);
		const data: Llama3Response = await response.json();
		console.log("Llama3 Response:", data);
		return data;
		} catch (error) {
		console.error("Error sending data to Llama3:", error);
		return {
			model: "llama3:8b",
			created_at: new Date().toISOString(),
			done: false,
			done_reason: "error",
			message: { content: "Llama3 analysis failed." }
		};
		}
	} */

	async processWithLlama3(text: string): Promise<Llama3Response> {
		const url = "https://api.groq.com/openai/v1/chat/completions";
		const groqApiKey = this.settings.groqApiKey;
		const model = "llama-3.1-8b-instant";
	  
		try {
		  console.groupCollapsed("[Groq] Request");
		  console.log("Model:", model);
		  this.logPreview("Prompt:", text, 600);
		  console.groupEnd();
	  
		  const response = await fetch(url, {
			method: "POST",
			headers: {
			  "Content-Type": "application/json",
			  "Authorization": `Bearer ${groqApiKey}`
			},
			body: JSON.stringify({
			  model,
			  messages: [{ role: "user", content: text }],
			  stream: false
			})
		  });
	  
		  if (!response.ok) {
			const errText = await response.text().catch(() => "");
			console.log("[Groq] Error body:", errText);
			throw new Error(`Groq API returned ${response.status}`);
		  }
	  
		  const data = await response.json();
	  
		  // OpenAI format -> dein Llama3Response-Format mappen
		  const content =
			data?.choices?.[0]?.message?.content ??
			data?.choices?.[0]?.text ??
			"";
	  
		  const mapped: Llama3Response = {
			model,
			created_at: new Date().toISOString(),
			done: true,
			done_reason: data?.choices?.[0]?.finish_reason ?? "stop",
			message: { content }
		  };
	  
		  console.log("Groq Response (mapped):", mapped);
		  return mapped;
		} catch (error) {
		  console.error("Error sending data to Groq:", error);
		  return {
			model: "llama-3.1-8b-instant",
			created_at: new Date().toISOString(),
			done: false,
			done_reason: "error",
			message: { content: "Groq analysis failed." }
		  };
		}
	}	  

	async preCleanText(text: string): Promise<string> {
		let cleaned = text.replace(/\r\n|\r/g, "\n");
		cleaned = cleaned.replace(/([a-zA-Z])- *\n *([a-zA-Z])/g, "$1$2");
		cleaned = cleaned.replace(/\n{2,}/g, "\n\n");
		cleaned = cleaned.replace(/^\s*\d+\s*$/gm, "");
		cleaned = cleaned.replace(
		/^\s*(fig|figure|table|doi|arxiv|page|citation|see profile|reads|uploads|publications?|citations?)[:\s].*$/gim,
		""
		);
		cleaned = cleaned.replace(
		/(researchgate\.net|SEE PROFILE|READS|CITATIONS|uploaded by|downloads?|https?:\/\/[^\s]+)/gi,
		""
		);
		cleaned = cleaned.replace(/{.*?}@.*?\.\w{2,}/g, "");
		cleaned = cleaned.replace(/$$\d+(,\s*\d+)*$$/g, "");
		cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
		cleaned = cleaned.split("\n").map((line) => line.trim()).join("\n");
		return cleaned.trim();
	}

	async extractPDFTextFromNote(noteText: string): Promise<string> {
		const fullTextSectionRegex = /##\s*Full Text Extracted from PDF\s*\n([\s\S]*?)(?=\n##|$)/i;
		const match = noteText.match(fullTextSectionRegex);
		const raw = match ? match[1].trim() : "";
		return raw.replace(/^```[\s\S]*?\n/, "").replace(/\n```$/, "").trim();
	}

	async summarizeNoteWithMetadata(noteText: string): Promise<{ summary: string; metadata: any }> {
		const extractedText = await this.extractPDFTextFromNote(noteText);
		const cleanedText = await this.preCleanText(extractedText);
		const metadata = await this.extractCurrentNoteMetadata(noteText);
	
		const metadataNote = `
	--- METADATA ---
	Title: ${metadata.title || "N/A"}
	Authors: ${(metadata.authors || []).join(", ") || "N/A"}
	Conference/Journal: ${metadata.conference || "N/A"}
	Keywords: ${(metadata.keywords || []).join(", ") || "N/A"}
	`;
	
		const prompt = `${metadataNote}\n\nSummarize this academic paper concisely:\n\n${cleanedText}`;
		const response = await this.processWithLlama3(prompt);
		const summary = response.message.content.trim();
	
		return { summary, metadata };
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

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
