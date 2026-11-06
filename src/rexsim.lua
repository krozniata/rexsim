local KEY = "shift+cmd+i"
local TERM = "com.superlogical.terminal"

local function must(res, err)
  if err ~= nil then error(err, 0) end
  return res
end

local function viewers()
  local ids = {}
  for _, b in ipairs(must(rex.session.list_blocks{}).blocks or {}) do
    if b.creator_name == TERM then
      local p = rex.block.call(TERM, "process", { block_id = b.block_id })
      if p and p.foreground and p.foreground.name == "rexsim" then
        table.insert(ids, b.block_id)
      end
    end
  end
  return ids
end

rex.action{
  name = "rexsim_toggle",
  title = "Toggle rexsim",
  description = "Show an iOS simulator or Android emulator in a pane beside this one",
  category = "rexsim",
  keywords = "ios simulator iphone android emulator phone preview",
  run = function(ctx)
    local open = viewers()
    if #open > 0 then
      for _, id in ipairs(open) do
        must(rex.call("block.close", { session_id = ctx.session_id, block_id = id }))
      end
      return { closed = open }
    end
    -- The agent's pane receives screenshots sent with ^S.
    return must(rex.session.new_split{
      anchor_id = ctx.block_id,
      direction = "horizontal",
      side = "after",
      ratio = 0.35,
      focus = true,
      layout = rex.layout.block{
        flavor = TERM .. ".shell",
        label = "rexsim",
        options = { command = { BIN, "--agent", ctx.block_id } },
      },
    })
  end,
}
rex.bind(KEY, "rexsim_toggle")
