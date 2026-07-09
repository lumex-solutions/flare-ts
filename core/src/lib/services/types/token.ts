/**
 * The service identity vocabulary: the token every layer keys services by.
 */
import type { FlareService } from "../composition/flare-service.js";

/**
 * Class reference used as the identity key for a service in the container and registration map.
 *
 * The abstract construct signature ensures tokens cannot be instantiated directly by callers.
 */
export type ServiceToken<T extends FlareService> = abstract new(...args: never[]) => T;
