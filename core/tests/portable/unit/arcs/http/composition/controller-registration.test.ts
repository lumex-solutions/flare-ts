/**
 * Unit tests for controllerRegistration: the route-shaped registration a controller class becomes.
 */
import { describe, expect, it } from "vitest";
import { schema, str } from "@flare-ts/lib/schema";
import type { FlareHttpContext } from "../../../../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { Container } from "../../../../../../src/lib/services/container.js";
import { ControllerBase } from "../../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { httpContract } from "../../../../../../src/lib/arcs/http/composition/contract/http-contract.js";
import { controllerRegistration } from "../../../../../../src/lib/arcs/http/composition/controller-registration.js";
import { Get, Post } from "../../../../../../src/lib/arcs/http/routing/decorators.js";
import { flareConfig } from "../../../../../../src/lib/config/flare-config.js";
import { FlareService } from "../../../../../../src/lib/services/composition/flare-service.js";
import { flareState } from "../../../../../../src/lib/state/flare-state.js";

const NewUser = schema({ name: str });
const UsersContract = httpContract({ create: { body: NewUser } });
const UsersConfig = flareConfig("users", { table: str });
const Session = flareState<{ userId: string; }>("Session");

class UsersRepository extends FlareService {
  static override deps = [];
}

class UsersController extends ControllerBase {
  static override deps = [UsersRepository];
  static override state = [Session];
  static override contract = UsersContract;
  static override config = [UsersConfig];

  @Get("")
  list() {
    return null;
  }

  @Post("/new")
  create() {
    return null;
  }
}

class HealthController extends ControllerBase {
  static override deps = [];
  static override state = [];
  static override isolated = true;

  @Get("")
  live() {
    return null;
  }
}

describe("controllerRegistration", () => {
  it("records one route per decorated method, with the request descriptor its contract declares", () => {
    const registration = controllerRegistration("/users", UsersController);

    expect(registration.routes.map(({ method, path, handler }) => ({ method, path, handler: handler.name }))).toEqual([
      { method: "GET", path: "", handler: "list" },
      { method: "POST", path: "/new", handler: "create" },
    ]);
    expect(registration.routes[0]!.descriptor).toBeUndefined();
    expect(registration.routes[1]!.descriptor).toBe(UsersContract.create);
  });

  it("carries the class's path, name, deps, state, and config, and the class itself", () => {
    const registration = controllerRegistration("/users", UsersController);

    expect(registration.path).toBe("/users");
    expect(registration.name).toBe("UsersController");
    expect(registration.deps).toEqual([UsersRepository]);
    expect(registration.state).toEqual([Session]);
    expect(registration.config).toEqual([UsersConfig]);
    expect(registration.cls).toBe(UsersController);
  });

  it("reads isolation from static isolated, false when the class does not set it", () => {
    expect(controllerRegistration("/health", HealthController).isolated).toBe(true);
    expect(controllerRegistration("/users", UsersController).isolated).toBe(false);
  });

  it("builds a factory that constructs the class for each request", () => {
    const registration = controllerRegistration("/users", UsersController);
    const instance = registration.factory({} as Container, {} as FlareHttpContext);

    expect(instance).toBeInstanceOf(UsersController);
  });
});
