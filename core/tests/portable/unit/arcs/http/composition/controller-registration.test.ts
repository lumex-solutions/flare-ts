/**
 * Unit tests for controllerRegistration: the route-shaped registration a controller class becomes.
 */
import { assert, describe, expect, it } from "vitest";
import { schema, str } from "@flare-ts/lib/schema";
import { ControllerBase } from "../../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { httpContract } from "../../../../../../src/lib/arcs/http/composition/contract/http-contract.js";
import { controllerRegistration } from "../../../../../../src/lib/arcs/http/composition/controller-registration.js";
import { Get, Post } from "../../../../../../src/lib/arcs/http/routing/decorators.js";
import { flareConfig } from "../../../../../../src/lib/config/flare-config.js";
import { FlareService } from "../../../../../../src/lib/services/composition/flare-service.js";
import { flareState } from "../../../../../../src/lib/state/flare-state.js";
import { mockContainer, mockContext } from "../../../../../../src/lib/testing/mock.js";

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

  /** What a handler sees: the repository from the request's container, and the request's context. */
  request() {
    return { repository: this.inject(UsersRepository), ctx: this.ctx };
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

  it("builds a factory that constructs a fresh controller per request, on that request's container and context", () => {
    const repository = new UsersRepository(mockContainer(new Map()));
    const container = mockContainer(new Map([[UsersRepository, repository]]));
    const ctx = mockContext();
    const { factory } = controllerRegistration("/users", UsersController);

    const first = factory(container, ctx);
    assert(first instanceof UsersController);

    expect(factory(container, mockContext())).not.toBe(first);
    expect(first.request()).toEqual({ repository, ctx });
  });
});
