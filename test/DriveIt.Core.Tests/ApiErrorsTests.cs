using DriveIt.Core.Bridge;

namespace DriveIt.Core.Tests;

/// <summary>A revit_api_error names the member whose call raised it (spec #16 C8), the transaction calls included.</summary>
public class ApiErrorsTests
{
    [Fact]
    public void A_member_call_error_starts_with_the_type_and_member()
    {
        var message = ApiErrors.Message("WallType", "Duplicate", new ArgumentException("The name is already in use."));

        Assert.Equal("WallType.Duplicate: ArgumentException: The name is already in use.", message);
    }

    [Fact]
    public void Transaction_start_error_names_Transaction_Start()
    {
        var message = ApiErrors.Message("Transaction", "Start", new InvalidOperationException("The document is read-only."));

        Assert.Equal("Transaction.Start: InvalidOperationException: The document is read-only.", message);
    }

    [Fact]
    public void Transaction_commit_error_names_Transaction_Commit()
    {
        var message = ApiErrors.Message("Transaction", "Commit", new InvalidOperationException("A sub-transaction is still open."));

        Assert.Equal("Transaction.Commit: InvalidOperationException: A sub-transaction is still open.", message);
    }
}
