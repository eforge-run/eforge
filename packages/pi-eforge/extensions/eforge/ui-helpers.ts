/**
 * Shared TUI overlay utilities for native Pi command handlers.
 *
 * Provides reusable overlay patterns: select lists, info panels, and
 * loading indicators - wrapping the Container/SelectList/DynamicBorder
 * composition that the eforge_confirm_build tool established.
 */

import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

/** Minimal UI context type for overlay helpers. */
export interface UIContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    custom<T>(factory: (
      tui: { requestRender(): void },
      theme: { fg(color: string, text: string): string; bold(text: string): string },
      kb: unknown,
      done: (result: T) => void,
    ) => {
      render(width: number): string[];
      invalidate(): void;
      handleInput(data: string): void;
    }): Promise<T>;
    setStatus(key: string, text: string | undefined): void;
  };
}

/**
 * Show a select-list overlay and return the chosen item's value,
 * or null if the user cancelled.
 */
export async function showSelectOverlay(
  ctx: UIContext,
  title: string,
  items: SelectItem[],
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

    const visibleCount = Math.min(items.length, 15);
    const selectList = new SelectList(items, visibleCount, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/**
 * Show a read-only info overlay with markdown content.
 * Resolves when the user presses enter or esc.
 */
export async function showInfoOverlay(
  ctx: UIContext,
  title: string,
  content: string,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const container = new Container();
    const mdTheme = getMarkdownTheme();

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Markdown(content, 1, 1, mdTheme));

    const items: SelectItem[] = [
      { value: "close", label: "Close", description: "Dismiss this view" },
    ];

    const selectList = new SelectList(items, 1, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });

    selectList.onSelect = () => done(undefined);
    selectList.onCancel = () => done(undefined);

    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "enter/esc close"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/**
 * Run an async operation while showing a temporary loading status.
 */
export async function withLoader<T>(
  ctx: UIContext,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  ctx.ui.setStatus("eforge-loading", `⟳ ${label}`);
  try {
    return await fn();
  } finally {
    ctx.ui.setStatus("eforge-loading", undefined);
  }
}
