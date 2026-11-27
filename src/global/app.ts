import 'dot-stash';
import { initDesktopRuntime } from '../core/desktop-bridge';

export default function app(): void {
  // Importing 'dot-stash' instructs the Stencil compiler to include only the
  // dot-stash components referenced in mPlay3r (ds-trigger, ds-range, ds-icon,
  // ds-toggle, ds-select, ds-sortable, ds-badge, ds-tooltip, ds-toaster).
  // Automatically wires Tauri v2 portable storage & native dialogs on Desktop (no-op on Web/Embed).
  initDesktopRuntime();
}
