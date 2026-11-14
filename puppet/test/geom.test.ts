import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mirrorFrame, palmNormal, mpToThree } from "../src/geom";
import { framePalmNormal, palmFacing } from "../src/skeleton";
import { validateMotion, type Vec3 } from "../src/motion";

const fixture = validateMotion(JSON.parse(readFileSync(resolve(__dirname, "../fixtures/wave.json"), "utf8"))).motion;

describe("palmNormal", () => {
  // right hand held up, palm to the camera: index knuckle on the image right, pinky on the image left
  const right: Vec3[] = Array.from({ length: 21 }, () => [0, 0, 0] as Vec3);
  right[0] = [0, 0, 0]; right[5] = [0.03, -0.09, 0]; right[17] = [-0.03, -0.08, 0];
  it("points at the camera (z < 0) for a right palm facing the camera", () => {
    const n = palmNormal(right, "right");
    expect(n[2]).toBeLessThan(-0.99);
    expect(palmFacing(n)).toBe("camera");
  });
  it("flips for the left hand (the same points as a left hand show its back)", () => {
    expect(palmNormal(right, "left")[2]).toBeGreaterThan(0.99);
  });
  it("fixture: raised right palm faces the camera, resting palms face the body", () => {
    const f = fixture.frames[30];
    expect(palmFacing(framePalmNormal(f, "right", fixture)!)).toBe("camera");
    const f0 = fixture.frames[0];
    expect(palmFacing(framePalmNormal(f0, "left", fixture)!)).toBe("img-left");
    expect(palmFacing(framePalmNormal(f0, "right", fixture)!)).toBe("img-right");
  });
  it("image-space and world-space normals agree on the fixture", () => {
    const f = fixture.frames[40];
    const a = palmNormal(f.rightHand!, "right", [540, 720, 540]);
    const b = palmNormal(f.rightHandWorld!, "right");
    expect(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).toBeGreaterThan(0.99);
  });
});

describe("mirrorFrame", () => {
  it("swaps sides and flips x, so a mirrored right hand becomes the left hand", () => {
    const f = fixture.frames[30];
    const m = mirrorFrame(f);
    expect(m.leftHand![0][0]).toBeCloseTo(1 - f.rightHand![0][0]);
    expect(m.pose![11][0]).toBeCloseTo(1 - f.pose![12][0]);
    expect(m.poseWorld![15][0]).toBeCloseTo(-f.poseWorld![16][0]);
    // the palm still faces the camera after mirroring (the handedness formula flips with the label)
    expect(palmNormal(m.leftHand!, "left", [540, 720, 540])[2]).toBeLessThan(0);
    const back = mirrorFrame(m).pose!;
    back.forEach((p, k) => p.forEach((v, d) => expect(v).toBeCloseTo(f.pose![k][d], 9)));
  });
  it("mpToThree flips y and z", () => {
    expect(mpToThree([1, 2, 3])).toEqual([1, -2, -3]);
  });
});
