import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AprDisplay from './AprDisplay';

describe('AprDisplay', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders a loading state while the yield rate is being fetched', () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    );

    render(<AprDisplay />);

    expect(screen.getByTestId('apr-display-loading')).toBeInTheDocument();
  });

  it('renders the fixture APR value returned by the yield endpoint', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ rate: 0.0525 }),
    });

    render(<AprDisplay />);

    await waitFor(() => {
      expect(screen.getByTestId('apr-display-value')).toHaveTextContent('5.25%');
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/savings/yield/rate'),
      expect.anything(),
    );
  });
});
