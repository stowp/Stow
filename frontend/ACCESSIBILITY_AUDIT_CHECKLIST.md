# Accessibility Audit Checklist

## Overview
This checklist helps ensure the Stow application meets WCAG 2.1 Level AA standards and provides an inclusive experience for all users.

### Savings dashboard screen-reader support
The savings dashboard includes a skip-to-main-content link, focus movement to the main
landmark after client-side route changes, live announcements for summary and account
updates, and text descriptions for the portfolio allocation and projected growth charts.
These changes support the checklist items below but do not replace a full manual audit.

---

## 1. Keyboard Navigation

### 1.1 Focus Management
- [ ] All interactive elements are keyboard accessible (Tab/Shift+Tab)
- [ ] Focus order follows logical reading order
- [ ] Focus indicators are clearly visible (minimum 2px outline)
- [ ] No keyboard traps (users can escape from all components)
- [ ] Skip-to-content links are available on all pages
- [ ] Modal dialogs trap focus appropriately
- [ ] Focus returns to trigger element when modals/dropdowns close

### 1.2 Keyboard Shortcuts
- [ ] All functionality available via keyboard
- [ ] Keyboard shortcuts are documented
- [ ] Shortcuts don't conflict with browser/screen reader shortcuts
- [ ] Custom shortcuts can be disabled or remapped
- [ ] Single-key shortcuts can be turned off or remapped

---

## 2. Screen Reader Support

### 2.1 Semantic HTML
- [ ] Proper heading hierarchy (h1-h6, no skipped levels)
- [ ] Landmarks used correctly (header, nav, main, aside, footer)
- [ ] Lists use proper list markup (ul, ol, li)
- [ ] Forms use proper fieldset/legend grouping
- [ ] Tables have proper headers and captions

### 2.2 ARIA Implementation
- [ ] ARIA labels provided for icon buttons
- [ ] aria-label/aria-labelledby used for complex components
- [ ] aria-describedby used for helpful hints and error messages
- [ ] Live regions for dynamic content (aria-live, role="status", role="alert")
- [ ] aria-expanded for expandable elements
- [ ] aria-current for navigation states
- [ ] aria-hidden used appropriately (decorative elements only)
- [ ] No redundant ARIA (native semantics preferred)

### 2.3 Content Announcements
- [ ] Form validation errors announced to screen readers
- [ ] Success/error toasts announced via live regions
- [ ] Loading states announced
- [ ] Dynamic content updates announced
- [ ] Page title updates on route changes

---

## 3. Visual Design

### 3.1 Color Contrast
- [ ] Normal text: minimum 4.5:1 contrast ratio
- [ ] Large text (18pt+/14pt+ bold): minimum 3:1 contrast ratio
- [ ] UI components: minimum 3:1 contrast ratio
- [ ] Icons and graphics: minimum 3:1 contrast ratio
- [ ] Focus indicators: minimum 3:1 contrast ratio
- [ ] Test in both light and dark modes

### 3.2 Color Usage
- [ ] Information not conveyed by color alone
- [ ] Links distinguishable without relying on color
- [ ] Form errors indicated with icons/text, not just color
- [ ] Status indicators have text/icon alternatives

### 3.3 Text & Typography
- [ ] Minimum font size: 16px for body text
- [ ] Line height: minimum 1.5 for body text
- [ ] Paragraph spacing: at least 2x font size
- [ ] Text can be resized up to 200% without loss of content
- [ ] No horizontal scrolling at 320px viewport width
- [ ] Text alternatives provided for all images

---

## 4. Forms & Input

### 4.1 Labels & Instructions
- [ ] All form inputs have visible labels
- [ ] Labels properly associated with inputs (for/id)
- [ ] Required fields clearly marked
- [ ] Input purpose identified (autocomplete attributes)
- [ ] Helper text provided for complex inputs
- [ ] Format requirements explained before input

### 4.2 Validation & Errors
- [ ] Errors identified and described in text
- [ ] Error messages associated with inputs (aria-describedby)
- [ ] Inline validation doesn't interfere with input
- [ ] Error summary provided for forms with multiple errors
- [ ] Success confirmations provided
- [ ] Errors announced to screen readers

### 4.3 Interactive Controls
- [ ] Buttons have descriptive text/labels
- [ ] Touch targets minimum 44x44px
- [ ] Sufficient spacing between interactive elements
- [ ] Disabled states clearly indicated
- [ ] Loading states clearly indicated

---

## 5. Multimedia & Animation

### 5.1 Images & Icons
- [ ] Decorative images have empty alt text (alt="")
- [ ] Meaningful images have descriptive alt text
- [ ] Complex images have extended descriptions
- [ ] Icon buttons have aria-labels
- [ ] SVG icons have proper role and title/desc

### 5.2 Animation & Motion
- [ ] Respect prefers-reduced-motion setting
- [ ] No auto-playing animations longer than 5 seconds
- [ ] Pause/stop controls for moving content
- [ ] No flashing content (3 times per second threshold)
- [ ] Parallax and scrolling effects can be disabled

### 5.3 Video & Audio
- [ ] Videos have captions
- [ ] Audio content has transcripts
- [ ] Media players are keyboard accessible
- [ ] Auto-play can be disabled

---

## 6. Navigation & Structure

### 6.1 Navigation Patterns
- [ ] Multiple ways to find content (search, sitemap, nav)
- [ ] Breadcrumbs provided for deep navigation
- [ ] Current location indicated in navigation
- [ ] Consistent navigation across pages
- [ ] Navigation order is logical

### 6.2 Page Structure
- [ ] Each page has a unique, descriptive title
- [ ] Page language specified (lang attribute)
- [ ] Section headings describe page structure
- [ ] Main content area clearly defined
- [ ] Complementary content properly marked

---

## 7. Mobile & Responsive

### 7.1 Touch Interactions
- [ ] Touch targets minimum 44x44px
- [ ] Gestures have alternatives (swipe, pinch, etc.)
- [ ] Orientation changes supported
- [ ] Content reflows at different viewport sizes
- [ ] No horizontal scrolling required

### 7.2 Zoom & Magnification
- [ ] Pinch-to-zoom not disabled
- [ ] Content remains readable when zoomed
- [ ] No loss of functionality when zoomed
- [ ] Text scales appropriately

---

## 8. Web3 Specific

### 8.1 Wallet Integration
- [ ] Wallet connection states clearly announced
- [ ] Transaction signing process accessible
- [ ] Error messages descriptive and helpful
- [ ] Loading states during blockchain operations
- [ ] Alternative text for wallet addresses

### 8.2 Transaction Flows
- [ ] Multi-step processes clearly indicated
- [ ] Progress indicators accessible
- [ ] Confirmation dialogs keyboard accessible
- [ ] Transaction status updates announced
- [ ] Gas fees and costs clearly communicated

### 8.3 Smart Contract Data
- [ ] Contract addresses have copy buttons
- [ ] Blockchain explorers open in new tabs with warnings
- [ ] Token amounts have proper formatting
- [ ] Decimal precision clearly indicated

---

## 9. Performance & Timing

### 9.1 Time Limits
- [ ] No unexpected time limits
- [ ] Users can extend time limits
- [ ] Session timeout warnings provided
- [ ] Auto-save for form data

### 9.2 Loading States
- [ ] Loading indicators provided for delayed content
- [ ] Skeleton screens use proper ARIA
- [ ] Progressive loading doesn't break navigation
- [ ] Infinite scroll has load-more alternative

---

## 10. Testing Checklist

### 10.1 Automated Testing
- [ ] axe DevTools scan completed
- [ ] Lighthouse accessibility audit passed
- [ ] WAVE evaluation completed
- [ ] ESLint jsx-a11y rules enforced
- [ ] Unit tests include accessibility checks

### 10.2 Manual Testing
- [ ] Keyboard-only navigation tested
- [ ] Screen reader testing (NVDA/JAWS/VoiceOver)
- [ ] High contrast mode tested
- [ ] Browser zoom tested (200%, 400%)
- [ ] Mobile screen reader tested (iOS/Android)

### 10.3 User Testing
- [ ] Testing with users with disabilities
- [ ] Feedback from assistive technology users
- [ ] Usability testing with diverse users
- [ ] Real-world scenario testing

---

## 11. Documentation

### 11.1 Accessibility Documentation
- [ ] Accessibility statement published
- [ ] Known issues documented
- [ ] VPAT/ACR available if required
- [ ] Contact information for accessibility issues
- [ ] Keyboard shortcuts documented

### 11.2 Developer Documentation
- [ ] Accessibility guidelines for contributors
- [ ] Component accessibility requirements
- [ ] Testing procedures documented
- [ ] ARIA patterns documented

---

## Testing Tools & Resources

### Browser Extensions
- **axe DevTools**: Automated accessibility testing
- **WAVE**: Visual accessibility evaluation
- **Lighthouse**: Performance and accessibility audits
- **ARC Toolkit**: Comprehensive accessibility testing

### Screen Readers
- **NVDA** (Windows - Free): https://www.nvaccess.org/
- **JAWS** (Windows - Paid): https://www.freedomscientific.com/
- **VoiceOver** (Mac/iOS - Built-in): Command+F5
- **TalkBack** (Android - Built-in): Settings > Accessibility

### Testing Commands
- **NVDA**: Insert key (or Caps Lock) + modifier keys
- **VoiceOver**: Control+Option + modifier keys
- **JAWS**: Insert key + modifier keys

### Online Validators
- **WebAIM Contrast Checker**: https://webaim.org/resources/contrastchecker/
- **HTML Validator**: https://validator.w3.org/
- **Color Oracle**: Simulate color blindness

---

## Priority Levels

### Critical (Must Fix Before Launch)
- Keyboard navigation blocking issues
- Missing alt text for meaningful images
- Color contrast failures
- Form labels missing
- Screen reader blocking issues

### High (Fix Soon)
- ARIA implementation issues
- Focus management problems
- Inconsistent navigation
- Mobile accessibility issues

### Medium (Plan to Fix)
- Enhancement opportunities
- Advanced ARIA patterns
- Progressive enhancements

### Low (Nice to Have)
- Additional keyboard shortcuts
- Enhanced screen reader support
- Accessibility innovations

---

## Sign-off

### Review Completed By
- [ ] Developer: _________________ Date: _______
- [ ] QA: _________________ Date: _______
- [ ] Accessibility Specialist: _________________ Date: _______

### Notes
```
Add any additional notes, exceptions, or planned improvements here.
```

---

## Continuous Improvement

This checklist should be reviewed and updated:
- Before each major release
- When new components are added
- When WCAG guidelines are updated
- Based on user feedback
- After accessibility audits

**Last Updated**: [Date]
**Version**: 1.0
**WCAG Level Target**: AA (2.1)
