// Extension entry. The factory only registers and delegates; the web surface
// starts on session_start. herd-ui/noop is a deliberate no-op renderer: omp
// defers extensions that register nothing presentation-shaped until the first
// user input, and this keeps the fence available from the first frame.
import { wireUiExtension } from "./activation/index.mjs";
import { record } from "./host/diagnostics.mjs";
import { installComposerCapture, loadTuiModules, setRealCustomEditor } from "./host/tui-fence.mjs";

export function activate(pi, env = {}) {
	pi.registerMessageRenderer("herd-ui/noop", () => undefined);
	wireUiExtension(pi, env);
	void (async () => {
		try {
			const modules = await loadTuiModules(pi);
			if (modules?.CustomEditor) setRealCustomEditor(modules.CustomEditor);
			if (modules?.Composer) installComposerCapture({ ComposerClass: modules.Composer });
		} catch (error) {
			record("composer-capture", error);
		}
	})();
}

export default activate;
