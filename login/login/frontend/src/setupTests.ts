import "@testing-library/jest-dom/vitest";
import { setProjectAnnotations } from "@storybook/react";
import preview from "../.storybook/preview";

// Apply the Storybook preview (the MUI theme decorator + parameters) so stories
// composed in tests render exactly as they do in Storybook.
setProjectAnnotations(preview);
