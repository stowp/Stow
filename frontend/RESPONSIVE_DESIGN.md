# Responsive Design Guide

This document outlines the responsive design patterns and fixes applied to the Stow frontend application screens.

## Overview

All app screens have been verified and optimized for responsive behavior across the following breakpoints:

- **Mobile (Small)**: 375px × 667px (iPhone SE)
- **Mobile (Large)**: 414px × 896px (iPhone 11 Pro Max)
- **Tablet**: 768px × 1024px (iPad)
- **Desktop**: 1280px × 800px
- **Desktop (Large)**: 1920px × 1080px

## Breakpoints

The application uses Tailwind CSS v4 with the following breakpoints:

```css
sm: 640px   /* Small screens and up */
md: 768px   /* Medium screens and up */
lg: 1024px  /* Large screens and up */
```

## Core Responsive Patterns

### 1. Container Strategy

All pages use centered, max-width-constrained containers:

```tsx
<div className="min-h-screen bg-background p-6">
  <div className="mx-auto max-w-2xl">
    {/* Page content */}
  </div>
</div>
```

- **Form pages** (Goals, Groups, Settings): `max-w-2xl` (672px)
- **Dashboard sections**: `max-w-5xl` or `max-w-7xl`
- **Consistent padding**: `p-6` (24px) to prevent edge-to-edge content

### 2. Flexible Layouts

#### Flex Direction Changes
Stack elements vertically on mobile, horizontally on larger screens:

```tsx
className="flex flex-col sm:flex-row items-center gap-3"
```

#### Grid Responsiveness
Adapt column counts based on screen size:

```tsx
// Referrals stats: Always 3 columns, but with responsive padding
className="grid grid-cols-3 gap-3"

// With responsive padding
className="p-3 sm:p-4"
```

### 3. Typography Scaling

Headers scale appropriately across breakpoints:

```tsx
// Icon sizes
className="h-7 w-7 sm:h-8 sm:w-8"

// Text sizes
className="text-2xl sm:text-3xl"

// Also scales on stats
className="text-xl sm:text-2xl"
```

### 4. Text Handling

#### Long Content (Addresses, URLs)
Prevent horizontal overflow with proper text utilities:

```tsx
// Stellar addresses in groups
className="font-mono text-sm text-foreground break-all"

// Usernames/referral links
className="truncate"  // For single-line truncation
className="break-words"  // For multi-line wrapping

// Input fields with long content
className="w-full min-w-0 overflow-hidden text-ellipsis"
```

## Page-Specific Responsive Fixes

### Savings Goals Detail (`/savings/goals/[id]`)

**Issues Fixed:**
- Long goal names can now wrap properly
- Claim confirmation buttons stack on mobile
- Progress bars are fully responsive

**Key Changes:**
```tsx
// Header
<div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-2">
  <Target className="h-7 w-7 sm:h-8 sm:w-8 text-brand shrink-0" />
  <h1 className="text-2xl sm:text-3xl font-semibold text-foreground break-words">
    {goal.name}
  </h1>
</div>

// Buttons
<div className="flex flex-col sm:flex-row gap-3">
  <button className="flex-1">Confirm claim</button>
  <button className="flex-1">Cancel</button>
</div>
```

### Savings Groups Detail (`/savings/groups/[id]`)

**Issues Fixed:**
- Long Stellar addresses no longer cause horizontal overflow
- Member list items stack properly on mobile
- Amount displays maintain visibility on narrow screens

**Key Changes:**
```tsx
// Member list items
<li className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
  <span className="font-mono text-sm text-foreground break-all">
    {member.address}
  </span>
  <span className="text-sm text-muted sm:text-right whitespace-nowrap">
    {formatStroopsAmount(member.contributed)} XLM
  </span>
</li>
```

### Referrals Page (`/referrals`)

**Issues Fixed:**
- Referral link input no longer overflows
- Stats grid maintains 3-column layout with adjusted padding
- Referral list items stack on mobile

**Key Changes:**
```tsx
// Input field
<input className="w-full min-w-0 select-all rounded-xl overflow-hidden text-ellipsis" />

// Stats cards
<div className="grid grid-cols-3 gap-3">
  <div className="rounded-2xl p-3 sm:p-4">
    <p className="text-xl sm:text-2xl">{data.total}</p>
  </div>
</div>

// Referral items
<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
  <div className="min-w-0 flex-1">
    <p className="text-sm font-medium truncate">{username}</p>
  </div>
  <div className="sm:ml-4">
    <StatusBadge status={referral.status} />
  </div>
</div>
```

### Settings Page (`/settings`)

**Issues Fixed:**
- Toggle switches now align properly on mobile
- Long setting descriptions wrap correctly
- Time input grid stacks on mobile

**Key Changes:**
```tsx
// Notification categories
<div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
  <div className="flex-1 min-w-0">
    <h3>{category.label}</h3>
    <p>{category.description}</p>
  </div>
  <button className="shrink-0">Toggle</button>
</div>

// Time inputs
<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
  <input type="time" />
  <input type="time" />
</div>
```

## Common Responsive Utilities

### Overflow Prevention

```css
/* In globals.css */
body {
  overflow-x: hidden;
}
```

### Flex & Grid Utilities

```tsx
// Prevent shrinking
className="shrink-0"

// Allow text to wrap/break
className="break-words"
className="break-all"

// Truncate single lines
className="truncate"

// Minimum width for flex items
className="min-w-0"

// Full width within container
className="w-full"
```

### Spacing

```tsx
// Responsive padding
className="p-3 sm:p-4"
className="px-4 sm:px-6"

// Responsive gaps
className="gap-2 sm:gap-3"
className="gap-3 sm:gap-4"
```

## Testing

### Unit Tests

Responsive behavior is tested with viewport simulation:

```bash
npm test
```

See `src/__tests__/responsive.test.tsx` for viewport-based unit tests.

### E2E Tests

Visual regression tests at all breakpoints:

```bash
npm run test:e2e
```

See `e2e/responsive.spec.ts` for Playwright tests that:
- Check for horizontal overflow at each breakpoint
- Take screenshots for visual comparison
- Verify mobile navigation visibility
- Test touch target sizes (minimum 44×44px)

### Manual Testing

1. Open Chrome DevTools (Cmd+Option+I on macOS)
2. Toggle device toolbar (Cmd+Shift+M)
3. Test at each breakpoint:
   - 375px (iPhone SE)
   - 414px (iPhone 11 Pro Max)
   - 768px (iPad)
   - 1280px (Desktop)
   - 1920px (Large Desktop)
4. Check for:
   - No horizontal scrolling
   - Proper text wrapping
   - Button accessibility
   - Touch target sizes

## Mobile Navigation

The app uses a fixed bottom navigation bar on mobile (< 768px):

```tsx
<nav className="fixed inset-x-0 bottom-0 z-50 pb-[env(safe-area-inset-bottom)] md:hidden">
  {/* Navigation items */}
</nav>
```

**Safe Area Handling:**
- Uses `env(safe-area-inset-bottom)` for iPhone notches
- Hidden on desktop with `md:hidden`

## Accessibility

### Touch Targets

All interactive elements meet WCAG 2.5.5 minimum touch target size (44×44px) where possible.

### Focus States

All interactive elements include focus rings:

```tsx
className="focus:outline-none focus:ring-2 focus:ring-brand/50"
```

## Future Considerations

### Potential Improvements

1. **Landscape Mobile Support**: Add specific styles for landscape orientation
2. **Tablet-Specific Layouts**: Optimize for 768px-1024px range
3. **Dynamic Font Sizing**: Consider using `clamp()` for fluid typography
4. **Container Queries**: Use container queries when browser support improves

### Known Limitations

- Very long goal/group names (>100 characters) may still cause layout issues
- Extremely narrow viewports (<320px) are not officially supported
- Some third-party components may not be fully responsive

## Resources

- [Tailwind CSS Responsive Design](https://tailwindcss.com/docs/responsive-design)
- [WCAG 2.5.5 Target Size](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html)
- [Responsive Web Design Patterns](https://web.dev/patterns/layout/)
