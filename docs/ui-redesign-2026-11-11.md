# TEN-WICH UI/UX Redesign — 11.11.2026

## Overview

Complete visual redesign of the TEN-WICH mobile food ordering application based on the restaurant's chalkboard menu artwork.

## Design System

### Color Palette

| Purpose | Color | Hex |
|---------|-------|-----|
| Primary Navy | Dark backgrounds, headers | `#062D39` |
| Deep Teal | Secondary dark | `#083B43` |
| Lime Green | Primary actions, success | `#B6DE70` |
| Golden Yellow | Prices, highlights | `#FFC34D` |
| Turquoise | Borders, accents | `#32C8CE` |
| Pink | Playful accents | `#F48DB2` |
| Orange | Prices, warnings | `#FF963C` |
| Warm Cream | Content backgrounds | `#FFF8ED` |
| White | Cards, surfaces | `#FFFFFF` |
| Dark Text | Body text | `#102D36` |

### Typography

- **Font Family**: Rubik (Hebrew-optimized)
- **Headings**: ExtraBold (800)
- **Section Titles**: Bold (700)
- **Product Names**: SemiBold (600)
- **Body Text**: Regular/Medium (400-500)
- **Prices**: Bold (700-800)

### Spacing System

- Base unit: 8px
- Border radius: 12px (small), 20px (default), 28px (large)
- Shadows: Soft, subtle with brand-tinted colors

## Visual Hierarchy

### Header
- Dark navy background (#062D39)
- TEN-WICH logo prominently displayed
- Turquoise-bordered pill buttons

### Hero Section
- Dark navy with gradient text animation
- Floating food emoji decorations
- Rounded bottom corners for transition to content

### Content Areas
- Warm cream (#FFF8ED) background
- White cards with soft shadows
- Clean, breathable spacing

### Action Buttons
- Primary: Lime green gradient with glow
- Secondary: White with turquoise border on hover
- Minimum touch target: 48px

### Product Cards
- White background
- Rounded corners (12-20px)
- Subtle shadows
- Lime green selection state

## Files Changed

- `public/styles.css` - Complete CSS rewrite
- `public/index.html` - Header structure, theme colors, gradient updates

## Design Principles

1. **Mobile-First**: Optimized for smartphone viewing
2. **RTL Support**: Perfect Hebrew layout
3. **Brand Consistency**: Faithful to TEN-WICH visual identity
4. **Accessibility**: High contrast, clear typography
5. **Premium Feel**: Modern, polished, professional

## Notes

- No functional changes were made
- All existing content preserved
- Original menu items and prices unchanged
- All interactions and animations retained
