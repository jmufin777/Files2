# Gemini + Local File Search

Local file search with a Gemini chat assistant. Pick a folder in the browser, search by file name or file contents, and send selected file context to Gemini.

## Setup

Create a .env.local file in the project root:

GEMINI_API_KEY=your_api_key_here

## Development

npm run dev

## Notes

- Folder picking requires a browser that supports the File System Access API.
- File content is read locally in the browser and only sent to Gemini when you add files to context and send a prompt.
