export const streamdownPlugins = {};
export const streamdownPluginsWithoutRawHtml = {};
export const reasoningPlugins = {};
export const streamdownWordAnimation = { animation: "fadeIn", duration: 200, sep: "word" } as const;
export const streamdownSmoothStreamingAnimation = { ...streamdownWordAnimation, stagger: 0 } as const;
export function rehypeStreamingListItems() { return () => {}; }
