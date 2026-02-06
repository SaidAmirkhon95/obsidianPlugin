# Bachelor-Said – Obsidian Plugin

Bachelor-Said is an Obsidian plugin for **academic PDF analyse, structured note creation, retrieval-augmented generation (RAG), and LLaMA-powered chat** over your research papers.

It allows you to:
- Import PDF papers via drag & drop
- Automatically extract metadata and summaries
- Build a local semantic index
- Ask questions across one or multiple papers using LLaMA-3

---

## Features

- Drag & drop PDF import
- Automatic metadata & summary extraction
- Vector-based semantic search (RAG)
- Chat with your papers (LLaMA-3 via Groq)
- Multi-paper context reasoning

---

## Requirements

- **Obsidian (Desktop)**
  - https://obsidian.md/download
- **Node.js (LTS recommended)**
  - https://nodejs.org  
  *(npm is included with Node.js)*

---

## Installation (Manual / Development Mode)

This plugin is installed manually (not via the Obsidian Community Store yet).

### 1️⃣ Open your Obsidian plugins folder

Locate your vault and open:
`Obsidian Vault/.obsidian/plugins/`

Open this folder in a code editor (e.g. **VS Code**).

---

### 2️⃣ Clone the repository

Run in a terminal inside the `plugins` directory:

```bash
git clone https://github.com/SaidAmirkhon95/obsidianPlugin.git bachelor-said
```
---

### 3️⃣ Install Node.js (if not installed)

If Node.js is not installed yet:

Install Node.js (LTS)

Close your editor

Reopen the project folder

Verify installation:

node -v
npm -v

---

cd bachelor-said

`npm install`

Replace Rows:

69   openaiApiKey: "",

70   groqApiKey: "",

With separate provided keys!

---> npm run build <--- This generates the compiled plugin files used by Obsidian.

---

### 5️⃣ Enable the plugin in Obsidian

Open Obsidian:

Go to Settings → Community Plugins

Enable Bachelor-Said → Switch to ON

Reload Obsidian:

-Open Command Palette → Strg+P

-Run Command → Reload app without saving OR just close & reopen Obsidian

---

### 6️⃣ Verify installation

After reload, you should see a 🗨️ message-square icon in the left sidebar.

---

## How to Use

-Import PDF papers
-Drag & drop PDF files into any empty space in Obsidian

The plugin will automatically:

-extract text
-detect metadata
-generate summaries
-index the content for search & chat

---

Ask questions about your papers:

-Click the 🗨️ message-square icon
-The chat window opens

Ask questions about the current paper OR Add extra papers to the chat context.

⚠️ If you want to ask questions only about the current paper, remove extra papers from the context list.

---

🛠 Development Notes

Written in TypeScript

Uses:

Groq (OpenAI-compatible API)

OpenAI Embeddings

PDF.js for PDF extraction

⚠️ Disclaimer

This plugin is under active development and intended for academic and research workflows.
