# MLX benchmark decision

The decision file is generated from a schema-valid result with:

```bash
npx --no-install tsx tests/scripts/mlx-benchmark/run.ts validate \
  --result <result.json> \
  --schema tests/scripts/mlx-benchmark/result.schema.json
```

A go requires every configured artifact, correctness, tool, context, lifecycle,
and residency gate; two warmups and ten alternating paired observations per
performance cell; at least one primary metric whose paired-bootstrap 95% lower
bound is at least 20%; and no aggregate or workload-cell lower bound below
-10%. This harness selects only stock MLX. Custom execution and the
custom-versus-stock exception remain fail-closed until an experimental
candidate adds a pinned no-download lifecycle, required-capability evidence,
and a direct paired result contract.
