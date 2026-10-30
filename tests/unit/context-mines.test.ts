import { describe, expect, it } from "vitest";
import { ContextIndex } from "@/pipeline/context/annotate";
import { kindOf } from "@/pipeline/context/osm";

describe("mapped mines as context", () => {
  it("keeps only named or operated mines and quarries, never areas mapped as galamsey", () => {
    expect(kindOf({ landuse: "quarry", name: "Subika Pit", operator: "Newmont", resource: "gold" })).toBe("mine");
    expect(kindOf({ landuse: "quarry", operator: "Ghana Manganese Company" })).toBe("mine");
    expect(kindOf({ landuse: "industrial", industrial: "mine", name: "Perseus Ghana Mining Limited" })).toBe("mine");
    expect(kindOf({ landuse: "quarry", resource: "gold" })).toBeNull();
    expect(kindOf({ landuse: "quarry", name: "galamsey site", resource: "gold" })).toBeNull();
    expect(kindOf({ landuse: "industrial", industrial: "mine", name: "Galamsey site" })).toBeNull();
  });

  it("says when a detection is inside a mapped mine, or just outside its edge", () => {
    const ring = [
      [-2.37, 7.0],
      [-2.35, 7.0],
      [-2.35, 7.02],
      [-2.37, 7.02],
      [-2.37, 7.0],
    ];
    const index = ContextIndex.of([
      { kind: "mine", name: "Subika Pit (Newmont)", lon: -2.36, lat: 7.01, bbox: [-2.37, 7.0, -2.35, 7.02], geom: { type: "Polygon", coordinates: [ring] } },
    ]);
    const inside = index.place(-2.36, 7.01);
    expect(inside.mine).toBe("Subika Pit (Newmont)");
    expect(inside.flags[0]).toBe("Inside Subika Pit (Newmont), a mapped mine or quarry");

    const edge = index.place(-2.348, 7.01); // about 220 m east of the edge
    expect(edge.mine).toBeNull();
    expect(edge.nearby.find((n) => n.kind === "mine")?.distanceM).toBeGreaterThan(180);
    expect(edge.flags[0]).toMatch(/^2\d\d m from Subika Pit \(Newmont\), a mapped mine or quarry$/);

    expect(index.place(-2.30, 7.01).flags).toHaveLength(0);
  });
});
