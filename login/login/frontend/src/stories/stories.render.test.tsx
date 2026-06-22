import React from "react";
import { describe, it, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { composeStories } from "@storybook/react";

afterEach(() => cleanup());

// Render every story (i.e. every edge case captured in Storybook) in jsdom and
// assert it mounts without throwing — a fast, browser-less guard that the
// components handle each state. New stories are picked up automatically.
const modules = import.meta.glob("./**/*.stories.tsx", { eager: true });

for (const [path, mod] of Object.entries(modules)) {
  const stories = composeStories(
    mod as Parameters<typeof composeStories>[0]
  );
  describe(path.replace(/^\.\//, ""), () => {
    for (const [name, Story] of Object.entries(stories)) {
      it(`renders ${name}`, () => {
        const Component = Story as React.ComponentType;
        render(<Component />);
      });
    }
  });
}
