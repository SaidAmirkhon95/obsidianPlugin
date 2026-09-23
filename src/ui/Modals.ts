// src/ui/Modals.ts
import { App, Modal, Setting } from 'obsidian';
import { ReviewImportData } from '../types';

export class DragAndDropModal extends Modal {
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

export class ReviewImportModal extends Modal {
    private resolveFn: (data: ReviewImportData | null) => void;
    private importData: ReviewImportData;
    private isSubmitted = false;

    constructor(app: App, data: ReviewImportData, resolveFn: (data: ReviewImportData | null) => void) {
        super(app);
        this.importData = data;
        this.resolveFn = resolveFn;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Review Extracted Data' });
        contentEl.createEl('p', { 
            text: 'Bitte überprüfe die Metadaten. Du kannst den Titel korrigieren oder Referenzen abwählen, um Vault-Spam zu vermeiden. Bekannte Autoren werden automatisch ge-merged.', 
            cls: 'setting-item-description' 
        });

        new Setting(contentEl).setName('Title').addText(cb => {
            cb.setValue(this.importData.title).onChange(v => this.importData.title = v);
            cb.inputEl.style.width = '100%';
        });

        new Setting(contentEl).setName('Authors').setDesc('Komma-getrennt').addTextArea(cb => {
            cb.setValue(this.importData.authors).onChange(v => this.importData.authors = v);
            cb.inputEl.style.width = '100%';
            cb.inputEl.style.minHeight = '60px';
        });

        new Setting(contentEl).setName('Venue/Conference').addText(cb => {
            cb.setValue(this.importData.conference).onChange(v => this.importData.conference = v);
        });

        new Setting(contentEl).setName('Year').addText(cb => {
            cb.setValue(this.importData.year).onChange(v => this.importData.year = v);
        });

        contentEl.createEl('h3', { text: 'References to Import', cls: 'setting-item-heading' });
        
        const refContainer = contentEl.createDiv();
        refContainer.style.maxHeight = '200px';
        refContainer.style.overflowY = 'auto';
        refContainer.style.border = '1px solid var(--background-modifier-border)';
        refContainer.style.padding = '10px';
        refContainer.style.borderRadius = '5px';
        refContainer.style.marginBottom = '20px';

        if (this.importData.refs.length === 0) {
            refContainer.createEl('p', { text: 'Keine Referenzen gefunden.', cls: 'setting-item-description' });
        } else {
            this.importData.refs.forEach((refItem) => {
                const row = refContainer.createDiv();
                row.style.display = 'flex';
                row.style.alignItems = 'flex-start';
                row.style.gap = '8px';
                row.style.marginBottom = '6px';
                
                const cb = row.createEl('input', { type: 'checkbox' });
                cb.checked = refItem.selected;
                cb.onchange = () => refItem.selected = cb.checked;
                
                const label = row.createEl('span', { text: `${refItem.data.title || 'Unknown'} (${refItem.data.year || 'N/A'})` });
                label.style.fontSize = '13px';
                label.style.lineHeight = '1.3';
            });
        }

        const btnContainer = contentEl.createDiv();
        btnContainer.style.display = 'flex';
        btnContainer.style.justifyContent = 'flex-end';
        btnContainer.style.gap = '10px';

        const cancelBtn = btnContainer.createEl('button', { text: 'Cancel Import' });
        cancelBtn.onclick = () => this.close();

        const confirmBtn = btnContainer.createEl('button', { text: 'Confirm & Create Notes', cls: 'mod-cta' });
        confirmBtn.onclick = () => {
            this.isSubmitted = true;
            this.resolveFn(this.importData);
            this.close();
        };
    }

    onClose() {
        if (!this.isSubmitted) {
            this.resolveFn(null); 
        }
        this.contentEl.empty();
    }
}