// src/settings.ts
import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import BachelorSaidPlugin from './main';
import { MyPluginSettings } from './types';

export const DEFAULT_SETTINGS: MyPluginSettings = {
    mySetting: "default",
    topK: 15,
    chunkSize: 1500,
    chunkOverlap: 300,
    chatApiUrl: "https://ai.compute.isst.fraunhofer.de/api/generate",
    chatApiKey: "",
    chatModel: "llama3.3:70b",
    embedApiUrl: "https://ai.compute.isst.fraunhofer.de/api/embeddings",
    embedApiKey: "",
    embedModel: "nomic-embed-text:latest",
    fraunhoferRefreshToken: "",
};

export class BachelorSaidSettingTab extends PluginSettingTab {
    plugin: BachelorSaidPlugin;

    constructor(app: App, plugin: BachelorSaidPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'API & Modell Einstellungen' });

        // === NEU: FRAUNHOFER LOGIN BUTTON ===
        containerEl.createEl('h3', { text: 'Fraunhofer Authentifizierung' });
        containerEl.createEl('p', { text: 'Wenn du die Fraunhofer Server nutzt, klicke hier um dich einzuloggen. Der Token erneuert sich danach automatisch.' });

        new Setting(containerEl)
            .setName('Login via Browser')
            .setDesc('Öffnet den Browser. Nach Bestätigung wird der Token im Hintergrund geladen.')
            .addButton(btn => btn
                .setButtonText('Login Fraunhofer')
                .setCta()
                .onClick(async () => {
                    btn.setButtonText('Warte auf Browser...');
                    await this.plugin.startFraunhoferAuthFlow();
                    btn.setButtonText('Erfolgreich!');
                    setTimeout(() => this.display(), 2000); // UI neu laden, um die Keys anzuzeigen
                }));

        // --- CHAT API ---
        containerEl.createEl('h3', { text: 'Chat Modell (LLM)' });

        new Setting(containerEl)
            .setName('Chat API URL')
            .addText(text => text
                .setPlaceholder('URL')
                .setValue(this.plugin.settings.chatApiUrl)
                .onChange(async (value) => {
                    this.plugin.settings.chatApiUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Chat API Key (Bearer Token)')
            .setDesc('Wird automatisch vom Login-Button gefüllt.')
            .addText(text => text
                .setPlaceholder('eyJhbGci...')
                .setValue(this.plugin.settings.chatApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.chatApiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Chat Modell Name')
            .addText(text => text
                .setPlaceholder('Modellname')
                .setValue(this.plugin.settings.chatModel)
                .onChange(async (value) => {
                    this.plugin.settings.chatModel = value;
                    await this.plugin.saveSettings();
                }));

        // --- EMBEDDING API ---
        containerEl.createEl('h3', { text: 'Embedding Modell (Vektorisierung)' });

        new Setting(containerEl)
            .setName('Embedding API URL')
            .addText(text => text
                .setPlaceholder('URL')
                .setValue(this.plugin.settings.embedApiUrl)
                .onChange(async (value) => {
                    this.plugin.settings.embedApiUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Embedding API Key')
            .setDesc('Wird automatisch vom Login-Button gefüllt.')
            .addText(text => text
                .setPlaceholder('eyJhbGci...')
                .setValue(this.plugin.settings.embedApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.embedApiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Embedding Modell Name')
            .addText(text => text
                .setPlaceholder('Modellname')
                .setValue(this.plugin.settings.embedModel)
                .onChange(async (value) => {
                    this.plugin.settings.embedModel = value;
                    await this.plugin.saveSettings();
                }));

        // --- RAG PARAMETER ---
        containerEl.createEl('h3', { text: 'RAG Parameter (Wichtig für Präzision)' });

        new Setting(containerEl)
            .setName('Top K Retrieval')
            .addSlider(slider => slider
                .setLimits(1, 30, 1)
                .setValue(this.plugin.settings.topK)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.topK = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Chunk Size')
            .addText(text => text
                .setPlaceholder('1500')
                .setValue(String(this.plugin.settings.chunkSize))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num)) {
                        this.plugin.settings.chunkSize = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Chunk Overlap')
            .addText(text => text
                .setPlaceholder('300')
                .setValue(String(this.plugin.settings.chunkOverlap))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num)) {
                        this.plugin.settings.chunkOverlap = num;
                        await this.plugin.saveSettings();
                    }
                }));

        // --- INDEX MANAGEMENT ---
        containerEl.createEl('h3', { text: 'Datenbank Management' });

        new Setting(containerEl)
            .setName('RAG Index leeren')
            .addButton(btn => btn
                .setButtonText('⚠️ Clear Index')
                .setWarning()
                .onClick(async () => {
                    if (this.plugin.ragService.ragIndexPath && await this.plugin.app.vault.adapter.exists(this.plugin.ragService.ragIndexPath)) {
                        await this.plugin.app.vault.adapter.remove(this.plugin.ragService.ragIndexPath);
                        this.plugin.ragService.ragIndex = { version: 1, embeddingModel: this.plugin.settings.embedModel, chunks: [] };
                        new Notice('Index gelöscht.');
                    }
                }));
    }
}