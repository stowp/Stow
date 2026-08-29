# Responsive Design Verification Checklist

## Pre-Testing Setup

### 1. Install Dependencies
```bash
cd frontend
pnpm install
```

### 2. Build the Application
```bash
pnpm run build
```

---

## Manual Testing Checklist

### General (All Pages)

#### Mobile (375px)
- [ ] No horizontal scrolling
- [ ] All text is readable
- [ ] Buttons are easily tappable (min 44×44px)
- [ ] Images and icons scale appropriately
- [ ] Forms are usable
- [ ] Navigation is accessible

#### Mobile Large (414px)
- [ ] No horizontal scrolling
- [ ] Content scales appropriately
- [ ] No awkward gaps or spacing issues

#### Tablet (768px)
- [ ] No horizontal scrolling
- [ ] Desktop navigation becomes visible
- [ ] Mobile bottom nav is hidden
- [ ] Grids show appropriate column counts
- [ ] Content uses available space well

#### Desktop (1280px)
- [ ] No horizontal scrolling
- [ ] Centered layout with max-width constraints
- [ ] Proper use of whitespace
- [ ] All responsive utilities functioning

#### Large Desktop (1920px)
- [ ] No horizontal scrolling
- [ ] Content doesn't stretch too wide
- [ ] Max-width constraints working
- [ ] Layout remains balanced

---

## Page-Specific Checks

### Savings Goals Detail (`/savings/goals/[id]`)

#### Mobile (375px)
- [ ] Goal name wraps properly (doesn't overflow)
- [ ] Icon and title are aligned
- [ ] Progress bar is full width
- [ ] Amount text is readable
- [ ] "Claim goal" button is full width
- [ ] Confirm/Cancel buttons stack vertically

#### Desktop (1280px)
- [ ] Icon and title are on same line
- [ ] Confirm/Cancel buttons are side by side
- [ ] Content centered with max-w-2xl

**Test with:**
- Short goal name: "Laptop"
- Long goal name: "Super Long Goal Name That Should Wrap on Mobile Devices Without Causing Horizontal Overflow Issues"

---

### Savings Groups Detail (`/savings/groups/[id]`)

#### Mobile (375px)
- [ ] Group name wraps properly
- [ ] Member addresses break correctly (no overflow)
- [ ] Member amounts visible and aligned
- [ ] Member list items stack vertically

#### Desktop (1280px)
- [ ] Member items show address and amount on same line
- [ ] Proper spacing between members

**Test with:**
- Short name: "Friends"
- Long name: "Very Long Group Name For Testing Responsive Layout Behavior"
- Long addresses: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

---

### Referrals Page (`/referrals`)

#### Mobile (375px)
- [ ] Referral link input doesn't overflow
- [ ] Copy button visible and functional
- [ ] Stats grid shows 3 columns (narrow but readable)
- [ ] Stats numbers scale down (text-xl)
- [ ] Referral list items stack vertically
- [ ] Username/address truncates if too long
- [ ] Status badges visible below username

#### Desktop (1280px)
- [ ] Referral link input at comfortable width
- [ ] Stats grid has comfortable padding
- [ ] Stats numbers at full size (text-2xl)
- [ ] Referral items show info and badge on same line

**Test with:**
- Long URL in input field
- Long username: "verylongusernamethatmightcauseissues"
- Multiple referrals in list

---

### Settings Page (`/settings`)

#### Mobile (375px)
- [ ] Page title wraps if needed
- [ ] Notification categories list readable
- [ ] Toggle switches aligned to right or stacked below
- [ ] Setting descriptions wrap properly
- [ ] Time inputs stack vertically
- [ ] All inputs full width
- [ ] Success/error messages visible

#### Desktop (1280px)
- [ ] Categories show label/description on left, toggle on right
- [ ] Time inputs side by side (2 columns)
- [ ] Comfortable spacing throughout

**Test with:**
- All toggles in various states
- Quiet hours enabled/disabled
- Different time values

---

## Automated Test Verification

### Unit Tests
```bash
pnpm test
```

Expected: All responsive tests pass
- [ ] Mobile viewport tests pass
- [ ] Tablet viewport tests pass
- [ ] Desktop viewport tests pass
- [ ] Container width tests pass
- [ ] No overflow detected

### E2E Tests
```bash
pnpm run test:e2e
```

Expected: All Playwright tests pass
- [ ] Screenshots generated for all breakpoints
- [ ] No horizontal overflow detected
- [ ] Mobile nav visibility tests pass
- [ ] Grid layout tests pass
- [ ] Touch target tests pass

---

## Browser Testing

### Chrome/Edge
- [ ] Mobile (DevTools)
- [ ] Tablet (DevTools)
- [ ] Desktop

### Safari
- [ ] iPhone (DevTools or actual device)
- [ ] iPad (DevTools or actual device)
- [ ] Desktop

### Firefox
- [ ] Mobile (DevTools)
- [ ] Desktop

---

## Accessibility Checks

### Keyboard Navigation
- [ ] All interactive elements reachable via Tab
- [ ] Focus indicators visible
- [ ] No keyboard traps

### Touch Targets (Mobile)
- [ ] All buttons at least 44×44px
- [ ] Adequate spacing between interactive elements
- [ ] Easy to tap without errors

### Screen Reader
- [ ] Headings properly structured (h1, h2, etc.)
- [ ] Form labels associated correctly
- [ ] ARIA labels present where needed

---

## Common Issues to Watch For

### Text Overflow
- [ ] Long usernames/addresses
- [ ] Long goal/group names
- [ ] URLs in input fields
- [ ] Date/time stamps

### Layout Breaks
- [ ] Buttons breaking out of containers
- [ ] Images exceeding container width
- [ ] Fixed-width elements on small screens
- [ ] Inadequate padding/margins

### Interaction Issues
- [ ] Buttons too small to tap
- [ ] Interactive elements too close together
- [ ] Text too small to read
- [ ] Contrast issues on different screens

---

## Performance Checks

### Mobile Device
- [ ] Smooth scrolling
- [ ] Quick touch response
- [ ] No layout shifts
- [ ] Fast page loads

### Network
- [ ] Works on slow 3G
- [ ] Works offline (if applicable)
- [ ] Images load progressively

---

## Sign-Off

### Developer Testing
- [ ] All manual checks completed
- [ ] All automated tests passing
- [ ] No console errors
- [ ] Code reviewed

**Tested by:** _________________
**Date:** _________________

### QA Testing
- [ ] Verified on actual mobile devices
- [ ] Verified on actual tablets
- [ ] Cross-browser testing completed
- [ ] Accessibility verified

**Tested by:** _________________
**Date:** _________________

---

## Notes

Use this space to document any issues found or special considerations:

```
[Your notes here]
```

---

## Quick Test URLs

When running locally:

- Savings Goal: `http://localhost:3000/savings/goals/[test-id]`
- Savings Group: `http://localhost:3000/savings/groups/[test-id]`
- Referrals: `http://localhost:3000/referrals`
- Settings: `http://localhost:3000/settings`

Replace `[test-id]` with actual IDs from your test data.
