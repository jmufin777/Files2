#!/usr/bin/env node
import { ChromaClient } from "chromadb";

const client = new ChromaClient({
  path: "./chroma-data",
});

console.log("ChromaDB client initialized.");
console.log("Server ready. Index and search via API routes /api/index and /api/search");
