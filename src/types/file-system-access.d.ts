// Minimal File System Access API typings used by this app.
// Some TS/lib.dom versions don't expose these methods yet.

declare global {
	interface FileSystemDirectoryHandle {
		entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
		keys(): AsyncIterableIterator<string>;
		values(): AsyncIterableIterator<FileSystemHandle>;
		[Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]>;
	}
}

export {};
