This _generates_ `mdast` `code` nodes either as immediately imported files (when
the source is not marked as `utf8`) or as a ref when it's `utf8`. Unless you
include `import --base` the default base directory is `.`.

IMPORTANT: If your globs have `{..}` in there, be sure to quote the glob
otherwise it can be unquoted.

## Style 1

This shows "simple" includes which just create mdast `code` cells and do not add
any flags or arguments with the `code` cells:

```contribute include --base "${mdSrcDirname}/../sundry" --interpolate
bash **/*.bash . --mime text/plain
bash "**/*.{sh,bash}" . --mime text/plain
text "**/*.{sh,bash,txt,text,html,json}" . --mime text/plain
utf8 "**/*.{pdf,doc,docx,ppt,pptx,xls,xlsx}" .
json https://microsoftedge.github.io/Demos/json-dummy-data/64KB.json 64KB.json
```

## Style 2

The following shows includes which create mdast `code` cells with sample flags /
arguments with the `code` cells (e.g. `--graph` and `--cwd` which are not
meaningful but are good exemplars):

```import --base "${mdSrcDirname}/../sundry" --interpolate
bash **/*.bash . --mime text/plain --graph INJECTED_BASH1 --cwd ${cwd}
bash "**/*.{sh,bash}" . --mime text/plain --graph INJECTED_BASH2 --cwd ${cwd}
text "**/*.{sh,bash,txt,text,html,json}" . --mime text/plain --graph INJECTED_FS_TEXT
utf8 "**/*.{pdf,doc,docx,ppt,pptx,xls,xlsx}" . --graph INJECTED_FS_BIN
json https://microsoftedge.github.io/Demos/json-dummy-data/64KB.json 64KB.json --graph INJECTED_REMOTE
```

When importing text the content is immediately loaded but if the content is
binary then it's the responsibility of the processing engine to stream it and do
something with it.

## Alternatives

These are identical, `import` and `include` are shortcuts for
`contribute include --labeled` or `contribute <name> --include --labeled`.

````markdown
```contribute include --labeled ...
```

```contribute myID --include --labeled ...
```

```include ...
```

```import ...
```
````
