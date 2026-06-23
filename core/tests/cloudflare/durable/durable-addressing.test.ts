// Tests for the `durable(namespace, name, opts?)` typed addressing helper.
// Uses a fake namespace to verify resolution paths without a real DO binding.
// Runs in the cloudflare pool (needs CF type environment for DurableObjectNamespace types).
import { describe, expect, it } from "vitest";
import { durable } from "../../../src/lib/host/runtime/cloudflare/index.js";

// ---------------------------------------------------------------------------
// Fake namespace helpers
// ---------------------------------------------------------------------------

/** Builds a minimal fake DurableObjectId. */
function fakeId(name: string): DurableObjectId {
  return {
    toString: () => name,
    equals: (other: DurableObjectId) => other.toString() === name,
    name,
  } as unknown as DurableObjectId;
}

/** Builds a minimal fake DurableObjectStub carrying a marker for assertions. */
function fakeStub(id: DurableObjectId, tag: string): DurableObjectStub<undefined> {
  return { id, _tag: tag } as unknown as DurableObjectStub<undefined>;
}

/**
 * Fake DurableObjectNamespace that records how each stub was resolved so tests
 * can assert which code path `durable` took.
 */
function makeFakeNamespace(
  tag = "default",
): DurableObjectNamespace<undefined> & { calls: string[]; } {
  const calls: string[] = [];
  const ns = {
    calls,
    idFromName(name: string): DurableObjectId {
      calls.push(`idFromName:${name}`);
      return fakeId(name);
    },
    get(
      id: DurableObjectId,
      opts?: DurableObjectNamespaceGetDurableObjectOptions,
    ): DurableObjectStub<undefined> {
      calls.push(`get:${id.toString()}:${JSON.stringify(opts ?? {})}`);
      return fakeStub(id, tag);
    },
    getByName(
      name: string,
      opts?: DurableObjectNamespaceGetDurableObjectOptions,
    ): DurableObjectStub<undefined> {
      calls.push(`getByName:${name}:${JSON.stringify(opts ?? {})}`);
      return fakeStub(fakeId(name), tag);
    },
    jurisdiction(
      jur: DurableObjectJurisdiction,
    ): DurableObjectNamespace<undefined> & { calls: string[]; } {
      calls.push(`jurisdiction:${jur}`);
      // Returns a child namespace that records into the same calls array.
      return makeFakeNamespace(`${tag}/${jur}`);
    },
    newUniqueId(): DurableObjectId {
      return fakeId("unique");
    },
    idFromString(id: string): DurableObjectId {
      return fakeId(id);
    },
  } as unknown as DurableObjectNamespace<undefined> & { calls: string[]; };
  (ns as any).calls = calls;
  return ns;
}

/**
 * Fake DurableObjectNamespace whose jurisdiction() returns a CHILD namespace that
 * records into the SAME shared calls array as the parent. This allows tests to
 * assert both the parent jurisdiction() call AND the child getByName() call on a
 * single array, proving the child received the expected arguments.
 */
function makeFakeNamespaceSharedCalls(
  tag = "default",
): DurableObjectNamespace<undefined> & { calls: string[]; } {
  const calls: string[] = [];

  function buildChild(childTag: string): DurableObjectNamespace<undefined> & { calls: string[]; } {
    const child = {
      // Child also points to the same calls array.
      get calls(): string[] {
        return calls;
      },
      idFromName(name: string): DurableObjectId {
        calls.push(`child:idFromName:${name}`);
        return fakeId(name);
      },
      get(
        id: DurableObjectId,
        opts?: DurableObjectNamespaceGetDurableObjectOptions,
      ): DurableObjectStub<undefined> {
        calls.push(`child:get:${id.toString()}:${JSON.stringify(opts ?? {})}`);
        return fakeStub(id, childTag);
      },
      getByName(
        name: string,
        opts?: DurableObjectNamespaceGetDurableObjectOptions,
      ): DurableObjectStub<undefined> {
        calls.push(`child:getByName:${name}:${JSON.stringify(opts ?? {})}`);
        return fakeStub(fakeId(name), childTag);
      },
      jurisdiction(
        jur: DurableObjectJurisdiction,
      ): DurableObjectNamespace<undefined> & { calls: string[]; } {
        calls.push(`child:jurisdiction:${jur}`);
        return buildChild(`${childTag}/${jur}`);
      },
      newUniqueId(): DurableObjectId {
        return fakeId("unique");
      },
      idFromString(id: string): DurableObjectId {
        return fakeId(id);
      },
    } as unknown as DurableObjectNamespace<undefined> & { calls: string[]; };
    return child;
  }

  const ns = {
    get calls(): string[] {
      return calls;
    },
    idFromName(name: string): DurableObjectId {
      calls.push(`idFromName:${name}`);
      return fakeId(name);
    },
    get(
      id: DurableObjectId,
      opts?: DurableObjectNamespaceGetDurableObjectOptions,
    ): DurableObjectStub<undefined> {
      calls.push(`get:${id.toString()}:${JSON.stringify(opts ?? {})}`);
      return fakeStub(id, tag);
    },
    getByName(
      name: string,
      opts?: DurableObjectNamespaceGetDurableObjectOptions,
    ): DurableObjectStub<undefined> {
      calls.push(`getByName:${name}:${JSON.stringify(opts ?? {})}`);
      return fakeStub(fakeId(name), tag);
    },
    jurisdiction(
      jur: DurableObjectJurisdiction,
    ): DurableObjectNamespace<undefined> & { calls: string[]; } {
      calls.push(`jurisdiction:${jur}`);
      return buildChild(`${tag}/${jur}`);
    },
    newUniqueId(): DurableObjectId {
      return fakeId("unique");
    },
    idFromString(id: string): DurableObjectId {
      return fakeId(id);
    },
  } as unknown as DurableObjectNamespace<undefined> & { calls: string[]; };
  return ns;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("durable(namespace, name, opts?)", () => {
  it("calls getByName(name) when no opts are provided", () => {
    const ns = makeFakeNamespace();
    const stub = durable(ns, "alpha");
    expect(stub).toBeDefined();
    expect(ns.calls).toEqual(["getByName:alpha:{}"]);
  });

  it("calls getByName(name, opts) when only locationHint is provided", () => {
    const ns = makeFakeNamespace();
    const stub = durable(ns, "beta", { locationHint: "weur" });
    expect(stub).toBeDefined();
    // locationHint is passed through to getByName directly.
    expect(ns.calls).toEqual(['getByName:beta:{"locationHint":"weur"}']);
  });

  it("uses jurisdiction().getByName(name) when jurisdiction is provided (no locationHint)", () => {
    const ns = makeFakeNamespace();
    const stub = durable(ns, "gamma", { jurisdiction: "eu" });
    expect(stub).toBeDefined();
    // jurisdiction() is called on the namespace, then getByName on the scoped namespace.
    expect(ns.calls).toContain("jurisdiction:eu");
  });

  it("uses jurisdiction().getByName(name, { locationHint }) when both opts are provided", () => {
    const ns = makeFakeNamespace();
    durable(ns, "delta", { jurisdiction: "eu", locationHint: "weur" });
    // jurisdiction() first, then getByName with the remaining opts on the scoped namespace.
    expect(ns.calls).toContain("jurisdiction:eu");
    // The scoped namespace's calls are separate from ns.calls; just assert jurisdiction fired.
    expect(ns.calls.filter((c) => c.startsWith("jurisdiction")).length).toBe(1);
  });

  it("returns the stub from getByName without casting (type carries through)", () => {
    // This test is structural: it compiles only if durable's return type is DurableObjectStub<T>.
    // We assert at runtime that the stub object is returned intact.
    const ns = makeFakeNamespace("typed");
    const stub = durable(ns, "echo");
    // The stub's id should be resolvable.
    expect(stub.id.toString()).toBe("echo");
  });
});

// ---------------------------------------------------------------------------
// Strengthened jurisdiction branch: shared-calls namespace proves both the
// parent jurisdiction() call AND the child getByName() call are recorded on
// the same array with the correct arguments.
// ---------------------------------------------------------------------------

describe("durable() jurisdiction branch - child getByName recorded on shared calls array", () => {
  it(
    "jurisdiction(j) records on the parent calls array AND child getByName records the expected name on the same array",
    () => {
      // Use the shared-calls namespace so jurisdiction() and the child
      // getByName() both write into the same `calls` array.
      const ns = makeFakeNamespaceSharedCalls();

      durable(ns, "gamma", { jurisdiction: "eu" });

      // The parent must have recorded jurisdiction("eu").
      expect(ns.calls).toContain("jurisdiction:eu");

      // The child's getByName must also appear on the SAME shared array,
      // proving durable() dispatched to the child namespace and passed
      // the expected instance name through.
      const childGetByName = ns.calls.find((c) => c.startsWith("child:getByName:"));
      expect(childGetByName).toBeDefined();
      expect(childGetByName).toContain("gamma");
    },
  );

  it(
    "jurisdiction(j) + locationHint: child getByName receives the name AND the locationHint opts on the shared calls array",
    () => {
      const ns = makeFakeNamespaceSharedCalls();

      durable(ns, "delta", { jurisdiction: "fedramp", locationHint: "enam" });

      // Parent recorded jurisdiction.
      expect(ns.calls).toContain("jurisdiction:fedramp");

      // Child getByName recorded with the expected name.
      const childCall = ns.calls.find((c) => c.startsWith("child:getByName:"));
      expect(childCall).toBeDefined();
      expect(childCall).toContain("delta");

      // The locationHint was forwarded to the child getByName opts.
      expect(childCall).toContain("enam");

      // Parent getByName was NOT called (jurisdiction path never falls back to the parent).
      expect(ns.calls.some((c) => c.startsWith("getByName:"))).toBe(false);
    },
  );
});
