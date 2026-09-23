import { App, MarkdownView, Notice, Plugin, TFile, requestUrl } from 'obsidian';
import { getDocument, GlobalWorkerOptions, PDFDocumentProxy } from 'pdfjs-dist';
import * as yaml from "js-yaml";

import { ILLMProvider } from './llm/ILLMProvider';
import { GenericLLMProvider } from './llm/GenericLLMProvider';
import { ChatView } from './ui/ChatView';
import { DragAndDropModal, ReviewImportModal } from './ui/Modals';
import { DEFAULT_SETTINGS, BachelorSaidSettingTab } from './settings';
import { MyPluginSettings, PDFItem, ReviewImportData } from './types';
import { RagService } from './services/RagService';

export const CHAT_VIEW_TYPE = 'llama3-chat-view';

GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.0.375/pdf.worker.mjs";

export default class BachelorSaidPlugin extends Plugin {
	settings!: MyPluginSettings;
	llmProvider!: ILLMProvider;
	ragService!: RagService;

	// ===== Folder constants =====
	public PAPERS_DIR = "01_papers";
	public PERSONS_DIR = "02_persons";
	public CONF_DIR = "03_conferences";
	public QUELLEN_DIR = "04_quellen";

	async onload() {
		await this.loadSettings();
		this.initializeLLMProvider();

		// RAG Service initialisieren
		this.ragService = new RagService(this);
		await this.ragService.init();

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
					if (file) await this.ragService.runRelevanceAnalysis(file); // GEÄNDERT: Aufruf über ragService
				});
			});
		});

		this.addSettingTab(new BachelorSaidSettingTab(this.app, this));
	}

	initializeLLMProvider() {
		this.llmProvider = new GenericLLMProvider(this);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async openChatView() {
		let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
	
		if (!leaf) {
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

	private async ensureFolder(path: string) {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (!existing) {
			await this.app.vault.createFolder(path).catch(() => {});
		}
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

	private extractEmails(text: string): string[] {
		const rx = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g;
		const found = (text.match(rx) ?? []).map(s => s.trim());
		return Array.from(new Set(found));
	}

	private extractReferencesBlock(fullText: string): string[] {
		if (!fullText || fullText.length < 500) return [];
		const searchArea = fullText.slice(Math.floor(fullText.length * 0.5));
		const refHeaderRegex = /(?:^|\n)\s*(?:\d+\.?\s*)?(?:References|Bibliography|Literatur|LITERATURVERZEICHNIS|Quellenverzeichnis|Reference)(?:[:\.]?)(?:\s*\n|\s+\[)/i;
		const match = searchArea.match(refHeaderRegex);

		if (match && match.index !== undefined) {
			const absoluteIndex = Math.floor(fullText.length * 0.5) + match.index;
			let startOfContent = absoluteIndex + match[0].length;
			if (match[0].includes("[")) {
				startOfContent = absoluteIndex + match[0].indexOf("[");
			}
			return [fullText.slice(startOfContent).trim()];
		}
		return [];
	}
	
	private parseName(rawName: string): { first: string; last: string } {
		let clean = rawName.replace(/\./g, "").trim().toLowerCase();
		clean = clean.replace(/\s+/g, " ");

		if (clean.includes(",")) {
			const parts = clean.split(",").map(s => s.trim());
			return { last: parts[0], first: parts.length > 1 ? parts[1] : "" };
		}

		const parts = clean.split(" ");
		if (parts.length === 1) {
			return { last: parts[0], first: "" };
		}
		
		const last = parts.pop()!; 
		const first = parts.join(" "); 
		return { last, first };
	}

	private async findExistingAuthorFile(nameToFind: string): Promise<TFile | null> {
		const target = this.parseName(nameToFind);
		if (!target.last) return null;

		const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(this.PERSONS_DIR));

		for (const file of files) {
			const cleanBasename = this.normalizeAuthorName(file.basename);
			const existingName = this.parseName(cleanBasename);

			if (existingName.last !== target.last) continue;
			const f1 = target.first;
			const f2 = existingName.first;

			if (!f1 || !f2) return file;
			if (f1.startsWith(f2) || f2.startsWith(f1)) {
				return file;
			}
		}
		return null;
	}

	public sanitizeFileName(name: string): string {
		if (!name) return "Untitled";
		let clean = name
			.replace(/[:]/g, " - ")
			.replace(/[\\/]/g, "-")
			.replace(/[*"<>|?]/g, "")
			.replace(/\s+/g, " ")
			.trim();

		if (clean.length > 150) {
			clean = clean.substring(0, 150).trim();
		}
		return clean;
	}

	private isMoreCompleteName(newName: string, oldFileName: string): boolean {
		const n = this.parseName(newName);
		const o = this.parseName(oldFileName);
		if (n.last !== o.last) return false;
		if (!o.first && n.first) return true;
		if (o.first && n.first) {
			if (n.first.length > o.first.length && n.first.startsWith(o.first)) {
				return true;
			}
		}
		return false;
	}

	getLevenshteinDistance(a: string, b: string): number {
		const matrix = [];
		let i, j;
		if (a.length === 0) return b.length;
		if (b.length === 0) return a.length;

		for (i = 0; i <= b.length; i++) { matrix[i] = [i]; }
		for (j = 0; j <= a.length; j++) { matrix[0][j] = j; }

		for (i = 1; i <= b.length; i++) {
			for (j = 1; j <= a.length; j++) {
				if (b.charAt(i - 1) == a.charAt(j - 1)) {
					matrix[i][j] = matrix[i - 1][j - 1];
				} else {
					matrix[i][j] = Math.min(
						matrix[i - 1][j - 1] + 1,
						Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
					);
				}
			}
		}
		return matrix[b.length][a.length];
	}

	getSimilarity(s1: string, s2: string): number {
		const longer = s1.length > s2.length ? s1 : s2;
		if (longer.length === 0) return 1.0;
		return (longer.length - this.getLevenshteinDistance(s1, s2)) / longer.length;
	}

	async upsertPersonNote(rawName: string, sourcePaperTitle: string) {
		const cleanName = this.normalizeAuthorName(rawName);
		if (!cleanName) return;

		const cleanPaperTitle = sourcePaperTitle.trim().replace(/[.,;:]+$/, "");
		let file = await this.findExistingAuthorFile(cleanName);
		await this.ensureFolder(this.PERSONS_DIR);

		if (file) {
			if (this.isMoreCompleteName(cleanName, file.basename)) {
				const parsed = this.parseName(cleanName);
				const formatCap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
				const niceFirst = parsed.first.split(" ").map(s => formatCap(s)).join(" ");
				const niceLast = formatCap(parsed.last);
				const niceFileName = niceFirst ? `${niceFirst} ${niceLast}` : niceLast;

				let safeFileName = this.sanitizeFileName(niceFileName);
				if (safeFileName.endsWith(".")) safeFileName = safeFileName.slice(0, -1);
				const newPath = `${this.PERSONS_DIR}/${safeFileName}.md`;

				const collision = this.app.vault.getAbstractFileByPath(newPath);
				if (!collision) {
					await this.app.fileManager.renameFile(file, newPath);
					const text = await this.app.vault.read(file);
					const newContent = text.replace(/^#\s+.*$/m, `# ${niceFileName}`);
					await this.app.vault.modify(file, newContent);
					new Notice(`Updated author: ${file.basename}`);
				}
			}
		}

		if (!file) {
			const parsed = this.parseName(cleanName);
			const formatCap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
			const niceFirst = parsed.first.split(" ").map(s => formatCap(s)).join(" ");
			const niceLast = formatCap(parsed.last);
			const fileNameStr = niceFirst ? `${niceFirst} ${niceLast}` : niceLast;
			
			let safeFileName = this.sanitizeFileName(fileNameStr);
			if (safeFileName.endsWith(".")) safeFileName = safeFileName.slice(0, -1);
			const path = `${this.PERSONS_DIR}/${safeFileName}.md`;
			
			const content = `---
tags:
  - type/person
  - source/automatic
date: ${new Date().toISOString().slice(0, 10)}
---

# ${fileNameStr}

## Associated Papers
`;
			try {
				file = await this.app.vault.create(path, content);
			} catch (e) {
				file = this.app.vault.getAbstractFileByPath(path) as TFile;
			}
		}

		if (!file) return;
		
		let linkTarget = "";
		const existingPaper = await this.findExistingPaperNote(cleanPaperTitle);
		if (existingPaper) {
			linkTarget = existingPaper.basename;
		} else {
			let safeTitle = this.sanitizeFileName(cleanPaperTitle);
			if (safeTitle.endsWith(".")) safeTitle = safeTitle.slice(0, -1);
			linkTarget = safeTitle;
		}

		const newLinkText = `[[${linkTarget}]]`;
		let contentText = await this.app.vault.read(file);
		const lines = contentText.split("\n");
		let duplicateFound = false;
		let bestMatchIndex = -1;
		let highestSim = 0.0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			const match = line.match(/^-\s*\[\[(.+?)\]\]/);
			if (match) {
				const existingTitle = match[1].split("|")[0]; 
				if (existingTitle.toLowerCase() === linkTarget.toLowerCase()) {
					duplicateFound = true;
					break; 
				}
				const sim = this.getSimilarity(existingTitle.toLowerCase(), linkTarget.toLowerCase());
				if (sim > 0.85 && sim > highestSim) { 
					duplicateFound = true;
					bestMatchIndex = i;
					highestSim = sim;
				}
			}
		}

		if (!duplicateFound) {
			await this.app.vault.append(file, `\n- ${newLinkText}`);
		} else if (bestMatchIndex !== -1 && highestSim > 0.85) {
			const oldLine = lines[bestMatchIndex];
			if (!oldLine.includes(linkTarget)) {
				lines[bestMatchIndex] = `- ${newLinkText}`;
				const newContent = lines.join("\n");
				await this.app.vault.modify(file, newContent);
			}
		}
	}

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
				return { frontmatter: fm, body: `# ${confTitle}\n\n` };
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
			return isInFolder && f.basename.toLowerCase() === sanitizedTitle;
		}) || null;
	}

	private async extractStructuredReferences(referencesRaw: string): Promise<any[]> {
		const truncatedRefs = referencesRaw.slice(0, 12000);
		const refPrompt = `You are a machine that outputs strict JSON. You do not speak.
Task: Extract academic references from the text below.

INPUT TEXT:
${truncatedRefs}

INSTRUCTIONS:
1. Identify academic papers/books. Ignore websites.
2. OUTPUT FORMAT: STRICT JSON Array of objects with keys: "title", "authors" (array), "year", "venue", "isAcademic" (boolean).
3. ESCAPE all backslashes and quotes properly.
4. Do NOT use Markdown code blocks. Just the raw JSON string.

JSON OUTPUT:`;
	
		const response = await this.llmProvider.processWithLLM(refPrompt);
		let content = response.message.content.trim();
		content = content.replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();

		try {
			return JSON.parse(content);
		} catch (e) {
			const recoveredItems: any[] = [];
			const objectMatches = content.matchAll(/\{[^{}]*\}/g);
			for (const match of objectMatches) {
				try {
					const item = JSON.parse(match[0]);
					if (item.title || item.authors) {
						recoveredItems.push(item);
					}
				} catch (innerE) {}
			}

			if (recoveredItems.length > 0) {
				return recoveredItems;
			}
			return this.parseFallbackTextList(truncatedRefs); 
		}
	}

	private parseFallbackTextList(text: string): any[] {
		const results: any[] = [];
		const lines = text.split('\n');
		
		for (const line of lines) {
			const cleanLine = line.trim();
			if (cleanLine.length < 20) continue;

			const yearMatch = cleanLine.match(/\((19|20)\d{2}[a-z]?\)/);
			if (yearMatch) {
				const year = yearMatch[1]; 
				const yearIndex = yearMatch.index || 0;
				
				let authorsRaw = cleanLine.substring(0, yearIndex).replace(/^\d+\.|^\[\d+\]/, '').trim();
				authorsRaw = authorsRaw.replace(/[.,;:]+$/, "");
				const authors = authorsRaw.split(/,|&|\sand\s/).map(a => a.trim()).filter(a => a.length > 2);

				const rest = cleanLine.substring(yearIndex + yearMatch[0].length).trim();
				const firstDotIndex = rest.indexOf('.');
				let title = "";
				let venue = "";

				if (firstDotIndex > 5) {
					title = rest.substring(0, firstDotIndex).replace(/^\.\s*/, "").trim();
					venue = rest.substring(firstDotIndex + 1).trim();
				} else {
					title = rest;
				}

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
	
	private getCanonicalName(name: string): string {
		return name.toLowerCase().replace(/[.,;]/g, " ").replace(/\s+/g, " ").trim();
	}

	private async upsertCitedPaperNote(meta: { title?: string; authors?: string[]; year?: string; venue?: string; }) {
		let rawTitle = (meta.title ?? "").trim();
		const splitMatch = rawTitle.match(/^(.{2,60}?)(?:\s*[:–-]\s*)(.*)$/);
		
		if (splitMatch) {
			const prefix = splitMatch[1]; 
			const suffix = splitMatch[2]; 
			if (meta.authors && meta.authors.some(a => prefix.toLowerCase().includes(this.parseName(a).last))) {
				rawTitle = suffix.trim();
			}
		}

		if (!rawTitle || rawTitle.length < 5) return;
		if (rawTitle.length < 30 && rawTitle.includes(",") && rawTitle.split(" ").length < 4) return; 

		const existingNote = await this.findExistingPaperNote(rawTitle);
		if (existingNote) return; 

		await this.ensureFolder(this.QUELLEN_DIR);

		let baseName = this.sanitizeFileName(rawTitle);
		if (baseName.endsWith(".")) baseName = baseName.slice(0, -1);
		const path = `${this.QUELLEN_DIR}/${baseName}.md`;

		const createdDate = new Date().toISOString().slice(0, 10);
		const uniqueAuthorLinks = new Set<string>();

		if (Array.isArray(meta.authors)) {
			for (const author of meta.authors) {
				let cleanName = this.normalizeAuthorName(author);
				if (!cleanName) continue;
				const existingPersonFile = await this.findExistingAuthorFile(cleanName);
				if (existingPersonFile) {
					uniqueAuthorLinks.add(`[[${existingPersonFile.basename}]]`);
				} else {
					const parsed = this.parseName(cleanName);
					const niceName = (parsed.first ? `${parsed.first} ${parsed.last}` : parsed.last)
						.replace(/\./g, "") 
						.replace(/\b\w/g, l => l.toUpperCase());
					uniqueAuthorLinks.add(`[[${niceName}]]`);
				}
			}
		}

		const venueLink = meta.venue ? `[[${meta.venue.replace(/"/g, "'")}]]` : "";
		const titleLink = `[[${rawTitle.replace(/"/g, "'")}]]`;

		const yamlFrontmatter = [
			"---",
			`title: "${titleLink}"`,
			`date: ${createdDate}`,
			"author:",
			...Array.from(uniqueAuthorLinks).map(link => `  - "${link}"`),
			...(venueLink ? [`conference: "${venueLink}"`] : []),
			`year: ${meta.year || "Unknown"}`,
			"tags:",
			"  - type/paper",
			"  - source/reference",
			"  - status/toread",
			"---",
			"",
			`# ${rawTitle}`,
			"",
			"## Summary",
			"_Automatically extracted reference from a parent PDF._",
			""
		].join("\n");

		try {
			await this.app.vault.create(path, yamlFrontmatter);
		} catch (e) {
			return;
		}
		
		for (const link of Array.from(uniqueAuthorLinks)) {
			const nameFromLink = link.replace(/^\[\[|\]\]$/g, "");
			await this.upsertPersonNote(nameFromLink, rawTitle);
		}
	}

	async handleDroppedPDF(file: File) {
		const initLoadingModal = new DragAndDropModal(this.app, `<i>Loading PDF and extracting metadata...</i>`);
		
		try {
			console.groupCollapsed(`[PDF Import] Started processing: ${file.name}`);
			console.log("File size:", (file.size / 1024 / 1024).toFixed(2), "MB");
			initLoadingModal.open();
	
			const fileBuffer = await file.arrayBuffer();
			const metadataBuffer = fileBuffer.slice(0);
			const binaryBuffer = fileBuffer.slice(0);
			
			console.log("[PDF Import] Extracting text via PDF.js...");
			const { text: pdfText, metadata: pdfInternalMetadata } = await this.extractPDFContent(metadataBuffer);
			const filenameBase = file.name.replace(/\.pdf$/i, "").trim();
			
			const cleanedText = await this.ragService.preCleanText(pdfText);
			const firstChunk = cleanedText.slice(0, 8000); 
			console.log(`[PDF Import] Text cleaned. First chunk length: ${firstChunk.length} chars.`);
	
			// === Step 1: Metadata Extraction ===
			const llamaPrompt = `Extract the following metadata from this academic paper content. ONLY return in this format:
Title: [Exact Title of the Paper]
Authors: [List of authors separated by commas]
Conference: [Conference or Journal Name]
Keywords: [List of keywords separated by commas]
Emails: [List of emails separated by commas OR leave empty if none]

--- START OF PAPER ---
${firstChunk}
--- END OF PAPER ---`;
	
			console.log("[PDF Import] Sending Metadata Request to LLM...");
			const llamaResponse = await this.llmProvider.processWithLLM(llamaPrompt);
			const content = llamaResponse.message.content.trim();
			console.log("[PDF Import] LLM Metadata Response:\n", content);
	
			const titleMatch = content.match(/Title:\s*(.+)/i);
			let realTitle = titleMatch ? titleMatch[1].trim() : "";
			realTitle = realTitle.replace(/^["']+|["']+$/g, "").trim();
			
			if (!realTitle || realTitle.length < 5 || realTitle.toLowerCase().includes("unknown title")) {
				console.warn("[PDF Import] LLM did not find a valid title. Using filename fallback.");
				realTitle = filenameBase;
			}
			
			const authorsMatch = content.match(/Authors:\s*(.+)/i);
			const confMatch = content.match(/Conference:\s*(.+)/i);
			const keywordsMatch = content.match(/Keywords:\s*(.+)/i);
			const emailsMatch = content.match(/Emails:\s*(.*)/i);
			
			let emails = emailsMatch ? emailsMatch[1].split(/[,;]/).map(e => e.trim()).filter(Boolean) : [];
			if (!emails.length) emails = this.extractEmails(firstChunk);
	
			const authors = authorsMatch ? authorsMatch[1].split(/,| and /).map(a => a.trim()) : ["Unknown Author"];
			let finalAuthors = authors.map(a => this.normalizeAuthorName(a)).filter(a => !!a);

			if (!finalAuthors.length) finalAuthors = ["Unknown Author"];
			let conferenceOrJournal = confMatch ? confMatch[1].trim() : "Unknown Conference/Journal";
			let keywords = keywordsMatch ? keywordsMatch[1].split(/[,;]/).map(k => k.trim()).filter(Boolean) : ["N/A"];
	
			let year = (typeof pdfInternalMetadata.year === "string" && pdfInternalMetadata.year.trim() !== "")
					? pdfInternalMetadata.year : "Unknown Year";
	
			initLoadingModal.updateContent(`<i>Metadata extracted: "${realTitle}". Summarizing...</i>`);
	
			// === Step 2: Summarize ===
			const maxChunkSize = 8000;
			const chunks: string[] = [];
			for (let i = 0; i < cleanedText.length; i += maxChunkSize) {
				chunks.push(cleanedText.slice(i, i + maxChunkSize));
			}
			console.log(`[PDF Import] Split document into ${chunks.length} chunks for summarization.`);
	
			const summaries: string[] = [];
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				initLoadingModal.updateContent(`<i>Summarizing chunk ${i + 1} of ${chunks.length}...</i>`);
				console.log(`[PDF Import] Generating summary for chunk ${i + 1}/${chunks.length}...`);
				const chunkPrompt = `Summarize the following part of an academic paper:
---
${chunk}
---`;
				const chunkResponse = await this.llmProvider.processWithLLM(chunkPrompt);
				summaries.push(chunkResponse.message.content.trim());
			}
	
			initLoadingModal.updateContent(`<i>Consolidating summaries...</i>`);
			console.log("[PDF Import] Consolidating partial summaries...");
			const consolidatePrompt = `You are given several partial summaries from chunks of an academic paper. Combine them into one concise, cohesive summary paragraph.
--- PARTIAL SUMMARIES ---
${summaries.map((s, idx) => `Summary ${idx + 1}: ${s}`).join('\n\n')}
--- END ---`;

			const finalSummaryResponse = await this.llmProvider.processWithLLM(consolidatePrompt);
			const finalSummary = finalSummaryResponse.message.content.trim();
			console.log("[PDF Import] Final Summary generated length:", finalSummary.length);
			
			// === ZITATE & REFERENZEN ===
			let extractedRefs: any[] = [];
			try {
				const refBlockRaw = this.extractReferencesBlock(cleanedText);
				if (refBlockRaw.length > 0 && refBlockRaw[0].length > 100) {
					console.log("[PDF Import] Found references block. Extracting JSON...");
					initLoadingModal.updateContent(`<i>🔍 Found references. Analyzing...</i>`);
					extractedRefs = await this.extractStructuredReferences(refBlockRaw[0]);
					console.log(`[PDF Import] Extracted ${extractedRefs.length} academic references.`);
				} else {
					console.log("[PDF Import] No references block detected in the text.");
				}
			} catch (refError) {
				console.error("[PDF Import] Reference extraction failed:", refError);
			}

			initLoadingModal.close();

			// === REVIEW MODAL ===
			const initialData: ReviewImportData = {
				title: realTitle,
				authors: finalAuthors.join(", "),
				conference: conferenceOrJournal,
				year: String(year),
				keywords: keywords.join(", "),
				refs: extractedRefs.filter(r => r.isAcademic).map(r => ({ selected: true, data: r }))
			};

			console.log("[PDF Import] Awaiting user confirmation via ReviewImportModal...");
			const approvedData = await new Promise<ReviewImportData | null>(resolve => {
				new ReviewImportModal(this.app, initialData, resolve).open();
			});

			if (!approvedData) {
				console.log("[PDF Import] User cancelled the import.");
				console.groupEnd();
				new Notice("Import abgebrochen.");
				return;
			}
			console.log("[PDF Import] User confirmed data:", approvedData);

			const finalLoadingModal = new DragAndDropModal(this.app, `<i>Saving files...</i>`);
			finalLoadingModal.open();

			realTitle = approvedData.title;
			finalAuthors = approvedData.authors.split(",").map(a => this.normalizeAuthorName(a)).filter(a => !!a);
			if (!finalAuthors.length) finalAuthors = ["Unknown Author"];
			conferenceOrJournal = approvedData.conference;
			year = approvedData.year;
			keywords = approvedData.keywords.split(",").map(k => k.trim()).filter(Boolean);

			let safeTitle = this.sanitizeFileName(realTitle);
			if (safeTitle.endsWith(".")) safeTitle = safeTitle.slice(0, -1);
			const titleForNote = safeTitle; 

			const createdDate = new Date().toISOString().slice(0, 10);
			const titleLink = `[[${titleForNote}]]`; 
			const authorLinks = finalAuthors.map(a => `[[${a}]]`);
			const conferenceLink = `[[${conferenceOrJournal.replace(/"/g, "'")}]]`;
			const keywordLinks = keywords.map(k => `[[${k}]]`);
			
			const yamlFrontmatter = [
				"---",
				`title: "${titleLink}"`, 
				`date: ${createdDate}`,
				"author:",
				...authorLinks.map(a => `  - "${a.replace(/"/g, "'")}"`),
				...(emails.length ? ["emails:", ...emails.map(e => `  - "${e.replace(/"/g, "'")}"`)] : []),
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
				"" 
			].join("\n");

			let extractedReferenceLinks: string[] = [];
			const selectedRefs = approvedData.refs.filter(r => r.selected).map(r => r.data);

			console.log(`[PDF Import] Processing ${selectedRefs.length} selected references...`);
			for (const ref of selectedRefs) {
				await this.upsertCitedPaperNote(ref).catch(e => console.warn("[PDF Import] Ref error", e));

				const refTitle = (ref.title ?? "").trim();
				if (refTitle && refTitle.length > 10) {
					const cleanRefTitle = refTitle.trim().replace(/[.,;:]+$/, "");
					let targetBasename = "";
					
					const existingPaper = await this.findExistingPaperNote(cleanRefTitle);
					if (existingPaper) {
						targetBasename = existingPaper.basename;
					} else {
						let safeBase = this.sanitizeFileName(cleanRefTitle);
						if (safeBase.endsWith(".")) safeBase = safeBase.slice(0, -1);
						targetBasename = safeBase;
					}
					extractedReferenceLinks.push(`- [[${targetBasename}]]`);
				}
			}

			console.log("[PDF Import] Saving binary PDF to vault...");
			const pdfFolder = "pdf";
			if (!this.app.vault.getAbstractFileByPath(pdfFolder)) {
				await this.app.vault.createFolder(pdfFolder).catch(() => {});
			}
			const pdfFileName = `${pdfFolder}/${file.name}`;
			if (!this.app.vault.getAbstractFileByPath(pdfFileName)) {
				await this.app.vault.createBinary(pdfFileName, binaryBuffer);
			}
			const pdfEmbed = `![[${pdfFileName}]]`;
	
			let referenceSection = "";
			if (extractedReferenceLinks.length > 0) {
				const uniqueLinks = [...new Set(extractedReferenceLinks)].sort();
				referenceSection = `\n${uniqueLinks.join("\n")}`;
			}

			const noteBody = yamlFrontmatter + `## Summary\n${finalSummary}\n\n## Full Text Extracted from PDF\n${cleanedText}\n\n## Extracted References\n${referenceSection}\n\n## PDF Viewer\n${pdfEmbed}\n`;

			const existingNote = await this.findExistingPaperNote(titleForNote); 
			let finalFile: TFile | undefined;

			if (existingNote) {
				const isInQuellen = existingNote.path.startsWith(this.QUELLEN_DIR);
				const isInPapers = existingNote.path.startsWith(this.PAPERS_DIR);

				if (isInPapers) {
					console.log("[PDF Import] Note already exists in papers directory.");
					new Notice(`Paper "${titleForNote}" already exists.`);
					finalFile = existingNote;
				} 
				else if (isInQuellen) {
					console.log("[PDF Import] Upgrading existing reference to full paper note.");
					finalLoadingModal.updateContent(`<i>Upgrading existing reference...</i>`);
					const newPath = `${this.PAPERS_DIR}/${titleForNote}.md`; 
					
					if (this.app.vault.getAbstractFileByPath(newPath)) {
						new Notice("Target filename busy. Updating content.");
						await this.app.vault.modify(existingNote, noteBody);
						finalFile = existingNote;
					} else {
						await this.app.fileManager.renameFile(existingNote, newPath);
						await new Promise(r => setTimeout(r, 100));
						await this.app.vault.modify(existingNote, noteBody);
						finalFile = existingNote;
						new Notice(`Upgraded reference to: ${titleForNote}`);
					}
				} else {
					finalFile = existingNote;
				}

			} else {
				console.log("[PDF Import] Creating new markdown note.");
				await this.ensureFolder(this.PAPERS_DIR);
				let noteFileName = `${this.PAPERS_DIR}/${titleForNote}.md`; 
				
				if (this.app.vault.getAbstractFileByPath(noteFileName)) {
					noteFileName = `${this.PAPERS_DIR}/${titleForNote} (1).md`;
				}

				if (!this.app.vault.getAbstractFileByPath(noteFileName)) {
					finalFile = await this.app.vault.create(noteFileName, noteBody);
					new Notice(`Imported: ${titleForNote}`);
				} else {
					new Notice("Error: File collision.");
					finalLoadingModal.close();
					console.groupEnd();
					return;
				}
			}

			console.log("[PDF Import] Updating related Person and Conference notes...");
			for (const a of finalAuthors) {
				if (a && a !== "Unknown Author") {
					await this.upsertPersonNote(a, titleForNote);
				}
			}
			if (conferenceOrJournal && conferenceOrJournal !== "Unknown Conference/Journal") {
				await this.upsertConferenceNote(conferenceOrJournal, String(year), titleForNote);
			}

			if (finalFile) {
				console.log("[PDF Import] Opening final file in workspace.");
				const leaf = this.app.workspace.getLeaf(true);
				await leaf.openFile(finalFile);
			}

			finalLoadingModal.close();
			console.log("[PDF Import] Finished successfully.");
			console.groupEnd();
			
		} catch (error: any) {
			const msg = String(error?.message ?? error);
			console.error("[PDF Import] CRITICAL Error processing dropped PDF:", error);
			new Notice("Failed to process PDF: " + msg.slice(0, 100));
			try { document.querySelectorAll('.modal-container').forEach(m => m.remove()); } catch(e) {}
			console.groupEnd();
		}
	}

	private normalizeAuthorName(raw: string): string {
		let s = (raw ?? "").trim();
		s = s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g, "").trim();
		s = s.replace(/\b(university|institute|department|lab|laboratory|gmbh|inc\.|ltd\.|company)\b.*$/i, "").trim();
		s = s.replace(/[\[\]\(\)]/g, ""); 
		s = s.replace(/[.,;:]+$/g, "").trim();
		if (s.length < 2) return "";
		return s;
	}

	async listNotesWithSummary(exclude?: TFile): Promise<TFile[]> {
		const all = this.app.vault.getMarkdownFiles();
		const out: TFile[] = [];
	
		for (const f of all) {
			if (exclude && f.path === exclude.path) continue;
			const text = await this.app.vault.read(f);
			// GEÄNDERT: Aufruf über ragService
			const summary = this.ragService.extractSummaryFromNoteText(text);
			if (summary) out.push(f);
		}
	
		out.sort((a, b) => a.basename.localeCompare(b.basename));
		return out;
	}

	async extractPDFContent(fileBuffer: ArrayBuffer): Promise<{ text: string; metadata: any }> {
		try {
			const loadingTask = getDocument({ data: fileBuffer });
			const pdf = await loadingTask.promise;
			const pagesText: string[] = [];
	
			const isNoise = (item: PDFItem) => {
				if (!item.str.trim()) return true;
				if (item.h < 3) return true;
				return false;
			};
	
			const formatLines = (items: PDFItem[]): string => {
				if (items.length === 0) return "";
				
				items.sort((a, b) => {
					const yDiff = b.y - a.y;
					if (Math.abs(yDiff) > (Math.min(a.h, b.h) / 2)) return yDiff; 
					return a.x - b.x; 
				});
	
				let out = "";
				let lastY = items[0].y;
				let lastItem: PDFItem = items[0];
	
				for (let i = 0; i < items.length; i++) {
					const item = items[i];
					const yDiff = Math.abs(item.y - lastY);
					
					if (i > 0 && yDiff > item.h * 0.6) { 
						const isParagraph = yDiff > item.h * 1.5;
						out += isParagraph ? "\n\n" : "\n";
					} else if (i > 0) {
						const xDist = item.x - (lastItem.x + lastItem.w);
						if (xDist > 2 && !item.str.match(/^\s/) && !lastItem.str.match(/\s$/)) {
							out += " ";
						}
					}
	
					out += item.str;
					lastY = item.y;
					lastItem = item;
				}
				return out;
			};
	
			const processPageItems = (items: PDFItem[], pageWidth: number, pageHeight: number): string => {
				if (items.length === 0) return "";
				
				const marginY = pageHeight * 0.05; 
				const contentItems = items.filter(i => i.y > marginY && i.y < (pageHeight - marginY));
	
				contentItems.sort((a, b) => b.y - a.y);
	
				const midX = pageWidth / 2;
				const centerTolerance = pageWidth * 0.1;
	
				const blocks: PDFItem[][] = [];
				let currentBlock: PDFItem[] = [];
	
				for (const item of contentItems) {
					const startsLeft = item.x < (midX - centerTolerance);
					const endsRight = (item.x + item.w) > (midX + centerTolerance);
					const isWide = startsLeft && endsRight;
	
					if (isWide) {
						if (currentBlock.length > 0) {
							blocks.push(currentBlock);
							currentBlock = [];
						}
						blocks.push([item]);
					} else {
						currentBlock.push(item);
					}
				}
				if (currentBlock.length > 0) blocks.push(currentBlock);
	
				let finalPageText = "";
	
				for (const block of blocks) {
					if (block.length === 0) continue;
	
					const centerCrossers = block.filter(i => i.x < midX && (i.x + i.w) > midX);
					const collisionRate = centerCrossers.length / block.length;
	
					let isTwoColumn = false;
					if (block.length > 5 && collisionRate < 0.1) {
						const hasLeft = block.some(i => (i.x + i.w) < midX);
						const hasRight = block.some(i => i.x > midX);
						if (hasLeft && hasRight) {
							isTwoColumn = true;
						}
					}
	
					if (isTwoColumn) {
						const colL = block.filter(i => (i.x + i.w/2) < midX);
						const colR = block.filter(i => (i.x + i.w/2) >= midX);
	
						finalPageText += formatLines(colL) + "\n";
						finalPageText += formatLines(colR) + "\n";
					} else {
						finalPageText += formatLines(block) + "\n";
					}
				}
	
				return finalPageText;
			};
	
			for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
				const page = await pdf.getPage(pageNo);
				const viewport = page.getViewport({ scale: 1.0 });
				const content = await page.getTextContent();
				
				const items: PDFItem[] = (content.items as any[]).map((it) => ({
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

	async startFraunhoferAuthFlow() {
		const clientId = "361754343730398585";
		const issuer = "https://auth.compute.isst.fraunhofer.de";

		try {
			// 1. Device Code anfragen
			const authRes = await requestUrl({
				url: `${issuer}/oauth/v2/device_authorization`,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: `client_id=${clientId}&scope=openid profile email offline_access`
			});

			const { verification_uri_complete, device_code, interval } = authRes.json;

			// 2. Browser für den Nutzer öffnen
			window.open(verification_uri_complete);
			new Notice("Browser geöffnet. Bitte dort einloggen...");

			// 3. Im Hintergrund pollen, bis der Nutzer bestätigt hat
			let polling = true;
			let pollInterval = (interval || 5) * 1000;

			while (polling) {
				await new Promise(r => setTimeout(r, pollInterval));

				const tokenRes = await requestUrl({
					url: `${issuer}/oauth/v2/token`,
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${device_code}&client_id=${clientId}`,
					throw: false // 400 Fehler (Pending) nicht werfen
				});

				const data = tokenRes.json;

				if (data.error) {
					if (data.error === "authorization_pending") {
						continue; // Nutzer hat noch nicht geklickt, weiter warten
					} else if (data.error === "slow_down") {
						pollInterval += 5000;
					} else {
						new Notice(`Auth Fehler: ${data.error}`);
						polling = false;
					}
				} else if (data.access_token) {
					// ERFOLG! Tokens speichern
					this.settings.chatApiKey = data.access_token;
					this.settings.embedApiKey = data.access_token;
					if (data.refresh_token) {
						this.settings.fraunhoferRefreshToken = data.refresh_token;
					}
					await this.saveSettings();
					
					// Provider aktualisieren
					this.llmProvider = new GenericLLMProvider(this); 
					
					new Notice("Fraunhofer Login erfolgreich! API Keys wurden gesetzt.");
					polling = false;
				}
			}
		} catch (err) {
			console.error("[Fraunhofer Auth]", err);
			new Notice("Netzwerkfehler beim Fraunhofer Login.");
		}
	}

	async refreshFraunhoferToken(): Promise<boolean> {
		const clientId = "361754343730398585";
		const issuer = "https://auth.compute.isst.fraunhofer.de";
		if (!this.settings.fraunhoferRefreshToken) return false;

		try {
			console.log("[Fraunhofer] Auto-refreshing expired token...");
			const res = await requestUrl({
				url: `${issuer}/oauth/v2/token`,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: `grant_type=refresh_token&refresh_token=${this.settings.fraunhoferRefreshToken}&client_id=${clientId}`,
				throw: false
			});

			if (res.status === 200 && res.json.access_token) {
				
				// === NEU: Sicherheitscheck ===
				// Überschreibe den Key im Einstellungsfeld NUR, wenn die URL auf Fraunhofer zeigt!
				if (this.settings.chatApiUrl.includes("fraunhofer.de")) {
					this.settings.chatApiKey = res.json.access_token;
				}
				if (this.settings.embedApiUrl.includes("fraunhofer.de")) {
					this.settings.embedApiKey = res.json.access_token;
				}

				// Den Refresh Token merken wir uns trotzdem heimlich für später
				if (res.json.refresh_token) {
					this.settings.fraunhoferRefreshToken = res.json.refresh_token;
				}
				await this.saveSettings();
				console.log("[Fraunhofer] Token successfully refreshed!");
				return true;
			}
		} catch (e) {
			console.error("[Fraunhofer] Auto-refresh failed", e);
		}
		return false;
	}
}