---
name: Lumina Design System
version: alpha
description: A premium dark-mode design system for the AI Image Analysis Studio, featuring a vibrant "Lime" accent.
colors:
  primary: "#13161e"
  secondary: "#0d1117"
  tertiary: "#6c8f00"
  on-tertiary: "#ffffff"
  surface: "#1c2128"
  text-primary: "#c2c7d0"
  text-secondary: "#7b8495"
  border: "#30363d"
  accent-hover: "#8eb901"
  glass-bg: "rgba(28, 33, 40, 0.7)"
typography:
  family: "Numans, sans-serif"
  h1:
    fontSize: "2rem"
    fontWeight: "700"
  h2:
    fontSize: "1.25rem"
    fontWeight: "600"
  h3:
    fontSize: "1rem"
    fontWeight: "500"
  body:
    fontSize: "1rem"
    fontWeight: "400"
    lineHeight: "1.6"
  label:
    fontSize: "0.75rem"
    fontWeight: "500"
    letterSpacing: "0.05em"
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
    border: "1px solid {colors.border}"
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-tertiary}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  tag:
    backgroundColor: "rgba(108, 143, 0, 0.1)"
    textColor: "{colors.tertiary}"
    rounded: "{rounded.full}"
    padding: "4px 12px"
---

## Overview

Lumina is defined by a high-tech, premium dark aesthetic that emphasizes clarity and focus for AI-driven image analysis. The design leverages a sophisticated "Lime" accent (#6c8f00) against a deep charcoal and navy foundation. It incorporates "Bricks" inspired 3D flipping card architecture for metadata exploration, creating a tactile and interactive experience.

## Colors

The palette is rooted in the "Lime" theme, providing a vibrant contrast to the dark environment.

- **Primary (#13161e):** The core background color, providing a deep, non-pure-black foundation.
- **Secondary (#0d1117):** Used for sidebar and navigation areas to provide depth through layering.
- **Tertiary (#6c8f00):** "Lumina Lime" — the primary driver for interaction, status indicators, and branding.
- **Surface (#1c2128):** The default background for cards and elevated components.
- **Text Primary (#c2c7d0):** A soft silver-grey for high readability without the harshness of pure white.
- **Border (#30363d):** Subtle lines for structural definition.

## Typography

Lumina uses **Numans** as its primary typeface, offering a clean, geometric feel that aligns with the AI/technical nature of the application.

- **Headings:** Use bold weights (600-700) with generous spacing to establish clear hierarchy.
- **Body:** Set to 16px with a 1.6 line height for comfortable reading of long analysis descriptions.
- **Labels:** Small caps or increased letter-spacing used for metadata and status labels to evoke a "terminal" or "instrument" feel.

## Components

### Cards
Cards are the primary unit of content. They feature a high corner radius (16px) and subtle border. The **"Bricks" flip mechanism** allows cards to reveal detailed metadata (tags, colors, prompt info) on their "back" face while keeping the "front" focused on the image and primary summary.

### Buttons
Primary actions use the Lumina Lime background. Hover states increase brightness and add a slight vertical lift (transform) to indicate interactivity.

### Tags
Tags are used for image categorization. They use a low-opacity Lime background with high-opacity Lime text to maintain brand consistency while being less "heavy" than solid buttons.

### Navigation Sidebar
A fixed sidebar with a subtle gradient and active state indicators (3px left border in Lime) ensures the user always knows their current context.
