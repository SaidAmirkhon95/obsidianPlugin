// src/types.ts
export interface PDFItem {
	str: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface MyPluginSettings {
    mySetting: string;
    topK: number;
    chunkSize: number;
    chunkOverlap: number;
    chatApiUrl: string;
    chatApiKey: string;
    chatModel: string;
    embedApiUrl: string;
    embedApiKey: string;
    embedModel: string;
    fraunhoferRefreshToken: string;
}  

export interface VectorChunk {
	id: string;
	filePath: string;
	fileName: string;
	chunkIndex: number;
	chunkType?: "meta" | "lead" | "section" | "body";
	section?: string;
	mtime?: number;
	text: string;
	embedding: number[];
	hash: string;
	updatedAt: string;
}  

export interface RagIndex {
  version: number;
  embeddingModel: string;
  chunks: VectorChunk[];
}

export interface ReviewImportData {
    title: string;
    authors: string;
    conference: string;
    year: string;
    keywords: string;
    refs: { selected: boolean; data: any }[];
}