import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  saves: defineTable({
    user: v.string(),
    code: v.string(),
    label: v.string(),
    timestamp: v.number(),
  }),
});
