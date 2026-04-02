import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const saveCode = mutation({
  args: {
    user: v.string(),
    code: v.string(),
    label: v.string(),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("saves", {
      user: args.user,
      code: args.code,
      label: args.label,
      timestamp: args.timestamp,
    });
  },
});

export const listSaves = query({
  args: {
    user: v.string(),
  },
  handler: async (ctx, args) => {
    // Fetch saves for this user, order by _creationTime ascending wait we need newest?
    // Convex queries are naturally ordered by _creationTime asc.
    // To get newest first, we use .order("desc").
    const saves = await ctx.db
      .query("saves")
      .filter((q) => q.eq(q.field("user"), args.user))
      .order("desc")
      .take(15);
    return saves;
  },
});
