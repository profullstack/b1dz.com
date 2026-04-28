import { afterEach, describe, expect, it } from 'vitest';
import { maybeBuildCexCexExecutor } from './factory.js';

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe('executor factory defaults', () => {
  it('arms CEX↔CEX executor by default in live mode', () => {
    delete process.env.ARB_EXECUTOR_CEX_CEX;
    delete process.env.V2_EXECUTOR_CEX_CEX;
    process.env.ARB_MODE = 'live';

    expect(maybeBuildCexCexExecutor()).not.toBeNull();
  });

  it('lets operators opt out of CEX↔CEX execution explicitly', () => {
    process.env.ARB_MODE = 'live';
    process.env.ARB_EXECUTOR_CEX_CEX = 'false';

    expect(maybeBuildCexCexExecutor()).toBeNull();
  });

  it('does not arm CEX↔CEX executor outside live mode', () => {
    delete process.env.ARB_EXECUTOR_CEX_CEX;
    delete process.env.V2_EXECUTOR_CEX_CEX;
    process.env.ARB_MODE = 'observe';

    expect(maybeBuildCexCexExecutor()).toBeNull();
  });
});
