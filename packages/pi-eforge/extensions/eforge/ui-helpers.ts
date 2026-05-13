/**
 * Shared TUI overlay utilities for native Pi command handlers.
 *
 * Provides reusable overlay patterns: select lists, info panels, and
 * loading indicators - wrapping the Container/SelectList/DynamicBorder
 * composition that the eforge_confirm_build tool established.
 */

import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Markdown, type SelectItem, SelectList, Text, matchesKey, Key, fuzzyFilter } from "@earendil-works/pi-tui";

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
 * Show a searchable select-list overlay with a filter input and return
 * the chosen item's value, or null if the user cancelled.
 */
export async function showSearchableSelectOverlay(
  ctx: UIContext,
  title: string,
  items: SelectItem[],
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const MAX_VISIBLE = 15;
    const container = new Container();

    const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
    const titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
    const helpText = new Text(
      theme.fg("dim", "type to filter • ↑↓ navigate • enter select • esc cancel"),
      1,
      0,
    );
    const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));

    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };

    let selectList = new SelectList(items, Math.min(items.length, MAX_VISIBLE), listTheme);

    const input = new Input();
    input.onSubmit = () => {
      const item = selectList.getSelectedItem();
      if (item) done(item.value);
    };
    input.onEscape = () => done(null);

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    function rebuildContainer(filteredItems: SelectItem[]) {
      container.clear();
      container.addChild(topBorder);
      container.addChild(titleText);
      container.addChild(input);
      selectList = new SelectList(filteredItems, Math.min(filteredItems.length, MAX_VISIBLE), listTheme);
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);
      container.addChild(helpText);
      container.addChild(bottomBorder);
    }

    rebuildContainer(items);

    return {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          selectList.handleInput(data);
        } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
          input.handleInput(data);
        } else {
          const before = input.getValue();
          input.handleInput(data);
          const after = input.getValue();
          if (before !== after) {
            if (!after) {
              rebuildContainer(items);
            } else {
              const filtered = fuzzyFilter(items, after, (item) => item.label);
              rebuildContainer(filtered);
            }
          }
        }
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
