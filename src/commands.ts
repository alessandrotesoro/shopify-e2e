import { AuthCapture } from "./commands/auth/capture.js";
import { AuthList } from "./commands/auth/list.js";
import { AuthRefresh } from "./commands/auth/refresh.js";
import { AuthRemove } from "./commands/auth/remove.js";
import { Auth } from "./commands/auth.js";
import { Run } from "./commands/run.js";

const commands = {
	auth: Auth,
	"auth:capture": AuthCapture,
	"auth:list": AuthList,
	"auth:refresh": AuthRefresh,
	"auth:remove": AuthRemove,
	run: Run,
};

export default commands;
