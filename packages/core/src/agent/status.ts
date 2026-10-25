import { type PackageManager, runCommand } from '../vite/routes/update.ts';
import { commandVersion, findOnPath, resolveWorkspacePackage } from './detect.ts';
import type { AgentProvider, LocatedCli } from './provider.ts';
import type { AgentProviderId, AgentProviderStatus, AgentStatus } from './types.ts';

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

function locateCli(provider: AgentProvider): LocatedCli | null {
  if (provider.locateCli) return provider.locateCli();
  const file = findOnPath(provider.cliCommand);
  return file ? { command: provider.cliCommand, file } : null;
}

function installCommandForPlatform(provider: AgentProvider): string {
  if (process.platform === 'win32' && provider.installCommandWindows) {
    return provider.installCommandWindows;
  }
  return provider.installCommand;
}

async function providerStatus(
  userCwd: string,
  provider: AgentProvider,
): Promise<AgentProviderStatus> {
  const sdk = provider.sdkPackage ? resolveWorkspacePackage(userCwd, provider.sdkPackage) : null;
  const cli = locateCli(provider);
  const cliVersionPromise = cli ? commandVersion(cli.file) : Promise.resolve(null);
  // A CLI-only provider is ready when its binary is installed and signed in.
  // An SDK provider is ready when the package is in the workspace; sign-in
  // stays the CLI's own concern. Model listing waits on that check so a
  // signed-out CLI is not asked for its models.
  const signedInPromise = provider.signedIn && cli ? provider.signedIn(cli) : Promise.resolve(null);
  const [cliVersion, signedIn] = await Promise.all([cliVersionPromise, signedInPromise]);
  const models = await provider.models(signedIn === false ? null : cli);
  const ready = provider.sdkPackage ? sdk !== null : cli !== null && signedIn === true;
  return {
    id: provider.id,
    name: provider.name,
    sdkPackage: provider.sdkPackage,
    sdkVersion: sdk?.version ?? null,
    cliCommand: cli?.command ?? provider.cliCommand,
    cliFound: cli !== null,
    cliVersion,
    installCommand: installCommandForPlatform(provider),
    signedIn: provider.signedIn ? signedIn : null,
    ready,
    models,
    disabledSettings: [...provider.disabledSettings],
  };
}

export async function agentStatus(
  userCwd: string,
  providers: Record<AgentProviderId, AgentProvider>,
  packageManager: PackageManager,
): Promise<AgentStatus> {
  const list = await Promise.all(
    Object.values(providers).map((provider) => providerStatus(userCwd, provider)),
  );
  return { enabled: true, packageManager, providers: list };
}

function installCommandFor(
  packageManager: PackageManager,
  pkg: string,
): { cmd: string; args: string[] } {
  switch (packageManager) {
    case 'pnpm':
      return { cmd: 'pnpm', args: ['add', '-D', pkg] };
    case 'yarn':
      return { cmd: 'yarn', args: ['add', '-D', pkg] };
    case 'bun':
      return { cmd: 'bun', args: ['add', '-d', pkg] };
    case 'npm':
      return { cmd: 'npm', args: ['install', '-D', pkg] };
  }
}

export function installSdk(
  packageManager: PackageManager,
  pkg: string,
  cwd: string,
): Promise<void> {
  return runCommand(installCommandFor(packageManager, pkg), cwd, INSTALL_TIMEOUT_MS);
}
