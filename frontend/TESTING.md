# Testing Guide

This document describes the testing infrastructure and conventions for the Stow frontend.

## Overview

The frontend uses a comprehensive testing approach with three layers:

1. **Unit/Component Tests** - Vitest + React Testing Library
2. **E2E Tests** - Playwright
3. **Type Safety** - TypeScript

## Unit & Component Tests (Vitest)

### Running Tests

```bash
# Run all unit tests once
pnpm test

# Run tests in watch mode (during development)
pnpm test:watch

# Run tests with coverage report
pnpm test:coverage
```

### Test Structure

- Test files are co-located with source files using the `.test.ts` or `.test.tsx` extension
- Component tests use React Testing Library for rendering and user interactions
- Tests follow the Arrange-Act-Assert pattern

### Example Test

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MyComponent from "./MyComponent";

describe("MyComponent", () => {
  it("renders correctly", () => {
    render(<MyComponent />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("handles user interaction", async () => {
    const user = userEvent.setup();
    render(<MyComponent />);

    await user.click(screen.getByRole("button"));
    expect(screen.getByText("Clicked")).toBeInTheDocument();
  });
});
```

### Coverage Thresholds

The project maintains a minimum coverage threshold of 70% for:

- Branches
- Functions
- Lines
- Statements

## End-to-End Tests (Playwright)

### Running E2E Tests

```bash
# Run all E2E tests (headless)
pnpm test:e2e

# Run with UI mode (interactive)
pnpm test:e2e:ui

# Run with visible browser
pnpm test:e2e:headed
```

### Test Files

E2E tests are located in the `e2e/` directory with the `.spec.ts` extension.

### Current Test Suites

1. **Landing Page** (`e2e/landing-page.spec.ts`)
   - Page load and rendering
   - Navigation functionality
   - Waitlist form validation
   - Mobile menu behavior
   - Scroll effects
   - Accessibility checks

2. **Auth Flow** (`e2e/auth-flow.spec.ts`)
   - Login flow with mocked backend
   - Protected route access
   - Session persistence
   - 401 handling
   - Logout flow

### Browser Coverage

Tests run on multiple browsers in CI:

- Chromium (Desktop)
- Firefox (Desktop)
- WebKit/Safari (Desktop)
- Mobile Chrome (Pixel 5)
- Mobile Safari (iPhone 12)

### Mocking Backend APIs

E2E tests mock backend responses using Playwright's route interception:

```typescript
await page.route("**/api/endpoint", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: "mock" }),
  });
});
```

## API Client Tests

The `api.ts` module has comprehensive test coverage for:

- ✅ Authorization header attachment
- ✅ Session token management
- ✅ 401 handling and session clearing
- ✅ Error normalization
- ✅ JSON parsing
- ✅ Request methods (GET, POST, PUT, PATCH, DELETE)
- ✅ Content-Type headers
- ✅ Credentials inclusion

## CI/CD Integration

All tests run automatically in GitHub Actions on:

- Pull requests
- Pushes to `main` and `develop` branches

### CI Workflow

1. **Lint** - ESLint checks
2. **Unit Tests** - Vitest with coverage reporting
3. **E2E Tests** - Playwright smoke tests
4. **Build** - Next.js production build

### CI Configuration

See `.github/workflows/frontend-ci.yml` for the complete configuration.

## Writing New Tests

### Component Tests Checklist

When adding tests for a new component, cover:

- [ ] Rendering with default props
- [ ] All interactive states (loading, error, success)
- [ ] User interactions (clicks, form inputs, etc.)
- [ ] Validation logic
- [ ] Accessibility (ARIA attributes, keyboard navigation)
- [ ] Edge cases (empty states, error boundaries)

### E2E Tests Checklist

When adding E2E tests, ensure:

- [ ] Happy path flow works end-to-end
- [ ] Error states are handled gracefully
- [ ] Mobile viewports are tested
- [ ] Loading states don't cause race conditions
- [ ] Backend APIs are properly mocked
- [ ] Authentication/authorization is verified

## Testing Best Practices

### Do's

- ✅ Use semantic queries (`getByRole`, `getByLabelText`) over `getByTestId`
- ✅ Test user behavior, not implementation details
- ✅ Mock external dependencies (APIs, third-party libraries)
- ✅ Keep tests focused and independent
- ✅ Use descriptive test names that explain what is being tested
- ✅ Clean up after tests (Vitest does this automatically)

### Don'ts

- ❌ Don't test library implementation details
- ❌ Don't rely on snapshot tests for everything
- ❌ Don't make tests dependent on each other
- ❌ Don't test styling unless it affects functionality
- ❌ Don't use `waitFor` without a good reason (prefer user events)

## Debugging Tests

### Vitest

```bash
# Run a specific test file
pnpm test src/components/WaitlistForm.test.tsx

# Run tests matching a pattern
pnpm test --grep "validation"

# Debug with Node inspector
node --inspect-brk ./node_modules/vitest/vitest.mjs
```

### Playwright

```bash
# Run with UI mode for debugging
pnpm test:e2e:ui

# Run with visible browser
pnpm test:e2e:headed

# Debug specific test
pnpm exec playwright test e2e/landing-page.spec.ts --debug
```

## Troubleshooting

### Common Issues

**Vitest: "Cannot find module '@/...'"**

- Ensure `vite-tsconfig-paths` is configured in `vitest.config.ts`

**Playwright: "Target closed" or "Navigation timeout"**

- Check that the dev server is running
- Increase timeout in `playwright.config.ts`
- Verify the `baseURL` is correct

**Tests pass locally but fail in CI**

- Check for timing issues (use proper `waitFor` utilities)
- Verify environment variables are set in CI
- Look for platform-specific issues (paths, line endings)

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/react)
- [Playwright Documentation](https://playwright.dev/)
- [Testing Library Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)
