"""Logprob to confidence score conversion."""

import math


def logprob_to_confidence(logprob):
    """Convert a single log-probability to confidence percentage (0-100, 2 decimals).

    confidence = e^logprob * 100
    """
    if logprob is None:
        return 0.0
    probability = math.exp(logprob)
    return round(probability * 100, 2)


def multi_token_confidence(logprobs):
    """Compute confidence for multi-token labels using geometric mean.

    geometric_mean = e^(mean of logprobs) * 100
    """
    if not logprobs:
        return 0.0
    mean_logprob = sum(logprobs) / len(logprobs)
    probability = math.exp(mean_logprob)
    return round(probability * 100, 2)
